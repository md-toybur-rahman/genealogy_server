const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 2000;
app.use(cors());
app.use(express.json({ limit: '9mb' }));

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@bookshelfcluster.p3s31ub.mongodb.net/?ssl=true&retryWrites=true&w=majority&appName=bookshelfCluster`;
const client = new MongoClient(uri, {
	serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
});

let firebaseKeys;
let firebaseKeysExpireAt = 0;

async function getFirebasePublicKeys() {
	if (firebaseKeys && Date.now() < firebaseKeysExpireAt) return firebaseKeys;
	try {
		const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
		if (!response.ok) throw new Error('Firebase signing-key service returned an error');
		firebaseKeys = await response.json();
		const cacheControl = response.headers.get('cache-control') || '';
		firebaseKeysExpireAt = Date.now() + Number(cacheControl.match(/max-age=(\d+)/)?.[1] || 3600) * 1000;
		return firebaseKeys;
	} catch (error) {
		error.statusCode = 503;
		throw error;
	}
}

async function verifyFirebaseToken(req) {
	const projectId = process.env.FIREBASE_PROJECT_ID;
	if (!projectId) {
		const error = new Error('Firebase authentication is not configured');
		error.statusCode = 503;
		throw error;
	}
	const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
	if (!token) throw new Error('A Firebase sign-in token is required');
	const parts = token.split('.');
	if (parts.length !== 3) throw new Error('Invalid sign-in token');
	let header;
	let payload;
	try {
		header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
		payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
	} catch {
		throw new Error('Invalid sign-in token');
	}
	if (header.alg !== 'RS256' || !header.kid) throw new Error('Invalid sign-in token');
	const certificate = (await getFirebasePublicKeys())[header.kid];
	if (!certificate) throw new Error('Unknown sign-in key');
	const verifier = crypto.createVerify('RSA-SHA256');
	verifier.update(`${parts[0]}.${parts[1]}`);
	verifier.end();
	if (!verifier.verify(certificate, Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid sign-in token signature');
	const now = Math.floor(Date.now() / 1000);
	if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}` ||
		!payload.sub || payload.sub.length > 128 || payload.exp <= now || payload.iat > now ||
		(payload.nbf && payload.nbf > now) || !payload.email || payload.email_verified !== true) {
		throw new Error('Invalid or unverified Firebase account');
	}
	return payload;
}

function profileComplete(profile) {
	return Boolean(profile?.name?.trim() && profile?.fathers_name?.trim() && profile?.phone_number?.trim());
}

function isValidPath(path) {
	return Array.isArray(path) && path.length <= 100 && path.every(index => Number.isInteger(index) && index >= 0);
}

function getNodeAtPath(root, path) {
	if (!isValidPath(path)) return null;
	let node = root;
	for (const index of path) {
		if (!Array.isArray(node?.children) || !node.children[index]) return null;
		node = node.children[index];
	}
	return node;
}

function appendMember(root, path, name, familyMemberId, photoURL = '') {
	const parent = getNodeAtPath(root, path);
	if (!parent || !Array.isArray(parent.children)) return 'missing_parent';
	if (parent.children.some(child => child.name?.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) return 'duplicate';
	parent.children.push({ name, familyMemberId, ...(photoURL ? { photoURL } : {}), children: [] });
	return 'added';
}

function setNodeNameAtPath(root, path, expectedName, newName) {
	const node = getNodeAtPath(root, path);
	if (!node || node.name !== expectedName) return false;
	node.name = newName;
	return true;
}

function removeNodeAtPath(root, path, expectedName) {
	if (!isValidPath(path) || path.length === 0) return false;
	const parent = getNodeAtPath(root, path.slice(0, -1));
	const index = path[path.length - 1];
	if (!Array.isArray(parent?.children) || !parent.children[index] || parent.children[index].name !== expectedName) return false;
	parent.children.splice(index, 1);
	return true;
}

function normalizePhotoUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && (url.hostname === 'i.ibb.co' || url.hostname === 'ibb.co') ? url.toString() : null;
	} catch {
		return null;
	}
}

function assignPairedMemberIds(englishRoot, banglaRoot) {
	let changedEnglish = false;
	let changedBangla = false;
	function visit(englishNode, banglaNode) {
		if (!englishNode || !banglaNode) return;
		let memberId = englishNode.familyMemberId || banglaNode.familyMemberId;
		if (!memberId) memberId = crypto.randomUUID();
		if (!englishNode.familyMemberId) { englishNode.familyMemberId = memberId; changedEnglish = true; }
		if (!banglaNode.familyMemberId) { banglaNode.familyMemberId = memberId; changedBangla = true; }
		const englishChildren = englishNode.children || [];
		const banglaChildren = banglaNode.children || [];
		for (let i = 0; i < Math.min(englishChildren.length, banglaChildren.length); i++) visit(englishChildren[i], banglaChildren[i]);
	}
	visit(englishRoot, banglaRoot);
	return { changedEnglish, changedBangla };
}

function listFamilyMembers(englishRoot, banglaRoot) {
	const members = new Map();
	function visitEnglish(node, fatherName = '') {
		if (!node) return;
		if (node.familyMemberId) members.set(node.familyMemberId, { family_member_id: node.familyMemberId, name: node.name, fathers_name: fatherName });
		for (const child of node.children || []) visitEnglish(child, node.name);
	}
	function visitBangla(node, fatherName = '') {
		if (!node) return;
		if (node.familyMemberId && members.has(node.familyMemberId)) {
			const member = members.get(node.familyMemberId);
			member.bangla_name = node.name;
			member.bangla_fathers_name = fatherName;
		}
		for (const child of node.children || []) visitBangla(child, node.name);
	}
	visitEnglish(englishRoot);
	visitBangla(banglaRoot);
	return [...members.values()].filter(member => member.bangla_name);
}

function findMemberNodeById(root, familyMemberId) {
	if (!root || !familyMemberId) return null;
	if (root.familyMemberId === familyMemberId) return root;
	for (const child of root.children || []) {
		const found = findMemberNodeById(child, familyMemberId);
		if (found) return found;
	}
	return null;
}

function setMemberPhotoById(root, familyMemberId, photoURL) {
	const member = findMemberNodeById(root, familyMemberId);
	if (!member) return false;
	member.photoURL = photoURL;
	return true;
}

function collectMemberProfiles(englishRoot, banglaRoot) {
	const members = new Map();
	function visitEnglish(node, fatherName = '') {
		if (!node) return;
		if (node.familyMemberId) members.set(node.familyMemberId, { name: node.name, fathers_name: fatherName });
		for (const child of node.children || []) visitEnglish(child, node.name);
	}
	function visitBangla(node) {
		if (!node) return;
		if (node.familyMemberId && members.has(node.familyMemberId)) members.get(node.familyMemberId).bangla_name = node.name;
		for (const child of node.children || []) visitBangla(child);
	}
	visitEnglish(englishRoot);
	visitBangla(banglaRoot);
	return members;
}

async function run() {
	await client.connect();
	const db = client.db('Genealogy');
	const comments = db.collection('comments');
	const englishTree = db.collection('genealogy_english');
	const banglaTree = db.collection('genealogy_bangla');
	const users = db.collection('users');
	const requests = db.collection('family_requests');
	const [initialEnglishTree, initialBanglaTree] = await Promise.all([englishTree.findOne({}), banglaTree.findOne({})]);
	if (initialEnglishTree && initialBanglaTree) {
		const { changedEnglish, changedBangla } = assignPairedMemberIds(initialEnglishTree, initialBanglaTree);
		if (changedEnglish) await englishTree.updateOne({ _id: initialEnglishTree._id }, { $set: { children: initialEnglishTree.children, familyMemberId: initialEnglishTree.familyMemberId } });
		if (changedBangla) await banglaTree.updateOne({ _id: initialBanglaTree._id }, { $set: { children: initialBanglaTree.children, familyMemberId: initialBanglaTree.familyMemberId } });
	}
	const bootstrapAdminEmail = process.env.GENEALOGY_ADMIN_EMAIL?.trim().toLowerCase();
	if (bootstrapAdminEmail) {
		await users.updateOne({ email: bootstrapAdminEmail, user_type: { $nin: ['user', 'admin'] } }, { $set: { user_type: 'admin' } });
	}
	await users.updateMany({ user_type: { $nin: ['user', 'admin'] } }, { $set: { user_type: 'user' } });
	await users.updateMany({ phone_visibility: { $nin: ['public', 'private'] } }, { $set: { phone_visibility: 'private' } });

	async function getOrCreateUser(claims) {
		const email = claims.email.trim().toLowerCase();
		let profile = await users.findOne({ firebaseUid: claims.sub });
		if (!profile) profile = await users.findOne({ email });
		const defaultRole = email === bootstrapAdminEmail ? 'admin' : 'user';
		if (!profile) {
			const inserted = await users.insertOne({
				firebaseUid: claims.sub,
				email,
				name: claims.name || '',
				bangla_name: '',
				fathers_name: '',
				phone_number: '',
				phone_visibility: 'private',
				photoURL: '',
				is_family_member: null,
				family_member_id: null,
				user_type: defaultRole,
				createdAt: new Date(),
				updatedAt: new Date(),
			});
			profile = await users.findOne({ _id: inserted.insertedId });
		} else {
			const updates = { firebaseUid: claims.sub, email, updatedAt: new Date() };
			if (email === bootstrapAdminEmail) updates.user_type = 'admin';
			else if (!profile.user_type) updates.user_type = defaultRole;
			await users.updateOne({ _id: profile._id }, { $set: updates });
			profile = await users.findOne({ _id: profile._id });
		}
		return profile;
	}

	const authenticate = ({ complete = false, admin = false } = {}) => async (req, res, next) => {
		try {
			const claims = await verifyFirebaseToken(req);
			const profile = await getOrCreateUser(claims);
			if (complete && !profileComplete(profile)) return res.status(428).json({ message: 'আগে নিজের profile সম্পূর্ণ করুন।' });
			if (admin && profile.user_type !== 'admin') return res.status(403).json({ message: 'এই কাজটি শুধু admin করতে পারবেন।' });
			req.authClaims = claims;
			req.profile = profile;
			return next();
		} catch (error) {
			return res.status(error.statusCode || 401).json({ message: error.statusCode === 503 ? error.message : 'সাইন ইন যাচাই করা যায়নি। আবার লগইন করুন।' });
		}
	};

	app.get('/genealogyEnglish', authenticate({ complete: true }), async (req, res) => res.json(await englishTree.find().toArray()));
	app.get('/genealogyBangla', authenticate({ complete: true }), async (req, res) => res.json(await banglaTree.find().toArray()));

	app.get('/users/me', authenticate(), (req, res) => {
		const { _id, email, name, bangla_name, fathers_name, phone_number, phone_visibility, photoURL, user_type, is_family_member, family_member_id } = req.profile;
		return res.json({ _id, email, name, bangla_name, fathers_name, phone_number, phone_visibility, photoURL, user_type, is_family_member, family_member_id, profile_complete: profileComplete(req.profile) });
	});

	app.put('/users/me', authenticate(), async (req, res) => {
		const { name, fathers_name: fathersName, phone_number: phoneNumber } = req.body || {};
		const values = [name, fathersName, phoneNumber];
		if (values.some(value => typeof value !== 'string' || !value.trim() || value.trim().length > 120)) {
			return res.status(400).json({ message: 'নিজের নাম, বাবার নাম ও মোবাইল নম্বর দিন।' });
		}
		await users.updateOne({ _id: req.profile._id }, { $set: {
			name: name.trim(), bangla_name: name.trim(), fathers_name: fathersName.trim(),
			phone_number: phoneNumber.trim(), updatedAt: new Date(),
		} });
		return res.json({ message: 'Profile সংরক্ষণ হয়েছে।' });
	});

	app.get('/family/members', authenticate(), async (req, res) => {
		const [enRoot, bnRoot] = await Promise.all([englishTree.findOne({}), banglaTree.findOne({})]);
		if (!enRoot || !bnRoot) return res.status(503).json({ message: 'Family tree load করা যায়নি।' });
		return res.json(listFamilyMembers(enRoot, bnRoot));
	});

	app.post('/images/profile', authenticate(), async (req, res) => {
		const image = req.body?.image;
		if (typeof image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 8_500_000) {
			return res.status(400).json({ message: 'PNG, JPG অথবা WebP ছবি ৬ MB-এর মধ্যে দিন।' });
		}
		if (!process.env.IMGBB_API_KEY) return res.status(503).json({ message: 'Server-এ IMGBB_API_KEY সেট করা নেই।' });
		try {
			const base64Image = image.slice(image.indexOf(',') + 1);
			const response = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(process.env.IMGBB_API_KEY)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ image: base64Image }),
			});
			const result = await response.json();
			if (!response.ok || !result.success || !result.data?.url) throw new Error('Imgbb upload failed');
			return res.json({ photoURL: result.data.url });
		} catch (error) {
			console.error('Profile photo upload failed:', error.message);
			return res.status(502).json({ message: 'ছবি Imgbb-তে upload করা যায়নি। আবার চেষ্টা করুন।' });
		}
	});

	app.get('/users', authenticate({ complete: true }), async (req, res) => {
		const allUsers = await users.find({}, { projection: { email: 0, firebaseUid: 0 } }).toArray();
		const isAdmin = req.profile.user_type === 'admin';
		return res.json(allUsers.map(person => {
			const canSeePhone = isAdmin || person._id.equals(req.profile._id) || person.phone_visibility === 'public';
			return {
				_id: person._id, name: person.name, bangla_name: person.bangla_name,
				fathers_name: person.fathers_name, photoURL: person.photoURL, family_member_id: person.family_member_id || null,
				phone_number: canSeePhone ? person.phone_number : null,
				phone_visibility: person.phone_visibility, user_type: person.user_type,
			};
		}));
	});

	app.post('/requests', authenticate({ complete: true }), async (req, res) => {
		const { type } = req.body || {};
		let request;
		if (type === 'member_add') {
			const { englishName, banglaName, parentEnglishPath, parentBanglaPath, photoURL } = req.body;
			if (![englishName, banglaName].every(value => typeof value === 'string' && value.trim() && value.trim().length <= 120) ||
				!isValidPath(parentEnglishPath) || !isValidPath(parentBanglaPath) || (photoURL && !normalizePhotoUrl(photoURL))) {
				return res.status(400).json({ message: 'দুই ভাষার নাম ও দুই tree-তে বাবা/মা নির্বাচন করুন।' });
			}
			const enRoot = await englishTree.findOne({});
			const bnRoot = await banglaTree.findOne({});
			const englishParent = enRoot && getNodeAtPath(enRoot, parentEnglishPath);
			const banglaParent = bnRoot && getNodeAtPath(bnRoot, parentBanglaPath);
			if (!englishParent || !banglaParent || !Array.isArray(englishParent.children) || !Array.isArray(banglaParent.children)) {
				return res.status(400).json({ message: 'নির্বাচিত বাবা/মা tree-তে নেই। Tree reload করে আবার চেষ্টা করুন।' });
			}
			request = {
				type, englishName: englishName.trim(), banglaName: banglaName.trim(), parentEnglishPath, parentBanglaPath,
				familyMemberId: crypto.randomUUID(), photoURL: photoURL ? normalizePhotoUrl(photoURL) : '',
				expectedEnglishParentName: englishParent.name, expectedBanglaParentName: banglaParent.name,
			};
		} else if (type === 'photo_add' || type === 'photo_change') {
			const { language, targetPath, familyMemberId, photoURL, expectedPhotoURL } = req.body;
			if (!['english', 'bangla'].includes(language) || !isValidPath(targetPath) ||
				typeof familyMemberId !== 'string' || !normalizePhotoUrl(photoURL)) {
				return res.status(400).json({ message: 'Member নির্বাচন করে সঠিক ছবি দিন।' });
			}
			const collection = language === 'english' ? englishTree : banglaTree;
			const root = await collection.findOne({});
			const member = root && getNodeAtPath(root, targetPath);
			if (!member || member.familyMemberId !== familyMemberId) return res.status(409).json({ message: 'Member-এর অবস্থান বদলেছে। Tree reload করে আবার চেষ্টা করুন।' });
			const linkedProfile = await users.findOne({ family_member_id: familyMemberId, is_family_member: true }, { projection: { photoURL: 1 } });
			const currentPhotoURL = linkedProfile?.photoURL || member.photoURL || '';
			if (type === 'photo_add' && currentPhotoURL) return res.status(409).json({ message: 'এই member-এর ছবি ইতিমধ্যে যুক্ত আছে। ছবি পরিবর্তনের request দিন।' });
			if (type === 'photo_change' && (!currentPhotoURL || expectedPhotoURL !== currentPhotoURL)) return res.status(409).json({ message: 'বর্তমান ছবিটি বদলে গেছে। Tree reload করে আবার চেষ্টা করুন।' });
			request = { type, language, targetPath, familyMemberId, expectedName: member.name, photoURL: normalizePhotoUrl(photoURL), expectedPhotoURL: currentPhotoURL, previousPhotoURL: currentPhotoURL };
		} else if (type === 'name_correction') {
			const { language, targetPath, proposedName, field = 'name' } = req.body;
			if (!['english', 'bangla'].includes(language) || !isValidPath(targetPath) ||
				!['name', 'fathers_name'].includes(field) ||
				typeof proposedName !== 'string' || !proposedName.trim() || proposedName.trim().length > 120) {
				return res.status(400).json({ message: 'নতুন নাম ও সদস্য নির্বাচন করুন।' });
			}
			const collection = language === 'english' ? englishTree : banglaTree;
			const root = await collection.findOne({});
			const currentNode = root && getNodeAtPath(root, targetPath);
			if (!currentNode) return res.status(404).json({ message: 'নির্বাচিত সদস্যকে পাওয়া যায়নি।' });
			request = { type, language, field, targetPath, expectedName: currentNode.name, familyMemberId: currentNode.familyMemberId, proposedName: proposedName.trim() };
		} else {
			return res.status(400).json({ message: 'Request-এর ধরন সঠিক নয়।' });
		}

		const inserted = await requests.insertOne({
			...request,
			status: 'pending',
			submittedBy: req.profile._id,
			submitterName: req.profile.name,
			submitterEmail: req.profile.email,
			createdAt: new Date(),
		});
		return res.status(201).json({ _id: inserted.insertedId, message: 'Request admin-এর কাছে পাঠানো হয়েছে।' });
	});

	app.get('/admin/requests', authenticate({ complete: true, admin: true }), async (req, res) => {
		const pending = await requests.find({ status: 'pending' }).sort({ createdAt: 1 }).toArray();
		return res.json(pending);
	});

	app.patch('/admin/requests/:id', authenticate({ complete: true, admin: true }), async (req, res) => {
		if (!ObjectId.isValid(req.params.id) || !['approved', 'rejected'].includes(req.body?.decision)) {
			return res.status(400).json({ message: 'সঠিক request ও সিদ্ধান্ত দিন।' });
		}
		const session = client.startSession();
		try {
			await session.withTransaction(async () => {
				const requestId = new ObjectId(req.params.id);
				const request = await requests.findOne({ _id: requestId, status: 'pending' }, { session });
				if (!request) throw new Error('REQUEST_NOT_PENDING');
				if (req.body.decision === 'approved' && request.type === 'member_add') {
					const enRoot = await englishTree.findOne({}, { session });
					const bnRoot = await banglaTree.findOne({}, { session });
					if (!enRoot || !bnRoot) throw new Error('TREE_NOT_INITIALIZED');
					if (getNodeAtPath(enRoot, request.parentEnglishPath)?.name !== request.expectedEnglishParentName ||
						getNodeAtPath(bnRoot, request.parentBanglaPath)?.name !== request.expectedBanglaParentName) throw new Error('PARENT_CHANGED');
					const enResult = appendMember(enRoot, request.parentEnglishPath, request.englishName, request.familyMemberId, request.photoURL);
					const bnResult = appendMember(bnRoot, request.parentBanglaPath, request.banglaName, request.familyMemberId, request.photoURL);
					if (enResult !== 'added' || bnResult !== 'added') throw new Error(enResult === 'duplicate' || bnResult === 'duplicate' ? 'DUPLICATE_MEMBER' : 'PARENT_NOT_FOUND');
					await englishTree.updateOne({ _id: enRoot._id }, { $set: { name: enRoot.name, children: enRoot.children } }, { session });
					await banglaTree.updateOne({ _id: bnRoot._id }, { $set: { name: bnRoot.name, children: bnRoot.children } }, { session });
				} else if (req.body.decision === 'approved' && request.type === 'name_correction') {
					const collection = request.language === 'english' ? englishTree : banglaTree;
					const root = await collection.findOne({}, { session });
					const target = root && getNodeAtPath(root, request.targetPath);
					if (!target || target.familyMemberId !== request.familyMemberId || !setNodeNameAtPath(root, request.targetPath, request.expectedName, request.proposedName)) throw new Error('MEMBER_CHANGED');
					await collection.updateOne({ _id: root._id }, { $set: { name: root.name, children: root.children } }, { session });
					const enRoot = request.language === 'english' ? root : await englishTree.findOne({}, { session });
					const bnRoot = request.language === 'bangla' ? root : await banglaTree.findOne({}, { session });
					for (const [familyMemberId, names] of collectMemberProfiles(enRoot, bnRoot)) {
						await users.updateMany({ family_member_id: familyMemberId, is_family_member: true }, { $set: { ...names, updatedAt: new Date() } }, { session });
					}
				} else if (req.body.decision === 'approved' && ['photo_add', 'photo_change'].includes(request.type)) {
					const enRoot = await englishTree.findOne({}, { session });
					const bnRoot = await banglaTree.findOne({}, { session });
					if (!enRoot || !bnRoot) throw new Error('TREE_NOT_INITIALIZED');
					const selectedRoot = request.language === 'english' ? enRoot : bnRoot;
					const selectedNode = getNodeAtPath(selectedRoot, request.targetPath);
					if (!selectedNode || selectedNode.familyMemberId !== request.familyMemberId || selectedNode.name !== request.expectedName) throw new Error('MEMBER_CHANGED');
					const englishMember = findMemberNodeById(enRoot, request.familyMemberId);
					const banglaMember = findMemberNodeById(bnRoot, request.familyMemberId);
					if (!englishMember || !banglaMember) throw new Error('MEMBER_CHANGED');
					const linkedProfile = await users.findOne({ family_member_id: request.familyMemberId, is_family_member: true }, { session, projection: { photoURL: 1 } });
					const currentPhotoURL = linkedProfile?.photoURL || englishMember.photoURL || banglaMember.photoURL || '';
					if (request.type === 'photo_add' && currentPhotoURL) throw new Error('PHOTO_ALREADY_SET');
					if (request.type === 'photo_change' && currentPhotoURL !== request.expectedPhotoURL) throw new Error('PHOTO_CHANGED');
					if (!setMemberPhotoById(enRoot, request.familyMemberId, request.photoURL) || !setMemberPhotoById(bnRoot, request.familyMemberId, request.photoURL)) throw new Error('MEMBER_CHANGED');
					await englishTree.updateOne({ _id: enRoot._id }, { $set: { name: enRoot.name, children: enRoot.children } }, { session });
					await banglaTree.updateOne({ _id: bnRoot._id }, { $set: { name: bnRoot.name, children: bnRoot.children } }, { session });
					await users.updateMany({ family_member_id: request.familyMemberId, is_family_member: true }, { $set: { photoURL: request.photoURL, updatedAt: new Date() } }, { session });
				}
				const result = await requests.updateOne({ _id: requestId, status: 'pending' }, { $set: {
					status: req.body.decision, reviewedBy: req.profile._id, reviewedAt: new Date(),
				} }, { session });
				if (result.modifiedCount !== 1) throw new Error('REQUEST_NOT_PENDING');
			});
			return res.json({ message: req.body.decision === 'approved' ? 'Request approve হয়েছে।' : 'Request reject হয়েছে।' });
		} catch (error) {
			const messages = {
				REQUEST_NOT_PENDING: [409, 'এই request আর pending নেই।'],
				TREE_NOT_INITIALIZED: [503, 'Database-এ family tree নেই।'],
				DUPLICATE_MEMBER: [409, 'একই বাবা/মায়ের অধীনে এই নামের সদস্য আগে থেকেই আছে।'],
				PHOTO_ALREADY_SET: [409, 'এই member-এর ছবি আগেই যুক্ত হয়েছে।'],
				PHOTO_CHANGED: [409, 'Request করার পর member-এর ছবি বদলে গেছে। নতুন request দিন।'],
				PARENT_NOT_FOUND: [409, 'নির্বাচিত বাবা/মাকে tree-তে পাওয়া যায়নি।'],
				PARENT_CHANGED: [409, 'Request করার পর নির্বাচিত বাবা/মায়ের tree position বদলেছে; আবার request দিন।'],
				MEMBER_CHANGED: [409, 'Request করার পর সদস্যের অবস্থান বা নাম বদলেছে; নতুন request নিন।'],
			};
			if (messages[error.message]) return res.status(messages[error.message][0]).json({ message: messages[error.message][1] });
			console.error('Request review failed:', error);
			return res.status(500).json({ message: 'Request update করা যায়নি।' });
		} finally {
			await session.endSession();
		}
	});

	app.get('/admin/users', authenticate({ complete: true, admin: true }), async (req, res) => {
		const result = await users.find({}, { projection: { firebaseUid: 0 } }).sort({ name: 1 }).toArray();
		return res.json(result);
	});

	app.patch('/admin/users/:id/role', authenticate({ complete: true, admin: true }), async (req, res) => {
		const { user_type: userType } = req.body || {};
		if (!ObjectId.isValid(req.params.id) || !['user', 'admin'].includes(userType)) return res.status(400).json({ message: 'সঠিক user ও role নির্বাচন করুন।' });
		const targetId = new ObjectId(req.params.id);
		if (targetId.equals(req.profile._id) && userType === 'user') return res.status(400).json({ message: 'নিজের admin role নিজে সরানো যাবে না।' });
		if (userType === 'user') {
			const target = await users.findOne({ _id: targetId });
			if (target?.user_type === 'admin' && await users.countDocuments({ user_type: 'admin' }) <= 1) {
				return res.status(409).json({ message: 'সিস্টেমে অন্তত একজন admin থাকতে হবে।' });
			}
		}
		const result = await users.updateOne({ _id: targetId }, { $set: { user_type: userType, updatedAt: new Date() } });
		if (result.matchedCount !== 1) return res.status(404).json({ message: 'User পাওয়া যায়নি।' });
		return res.json({ message: userType === 'admin' ? 'User-কে admin করা হয়েছে।' : 'Admin role সরানো হয়েছে।' });
	});

	app.delete('/admin/family-member', authenticate({ complete: true, admin: true }), async (req, res) => {
		if (req.authClaims.email.trim().toLowerCase() !== 'toyburrahman48@gmail.com') {
			return res.status(403).json({ message: 'এই family member delete করার অনুমতি শুধু নির্দিষ্ট admin account-এর আছে।' });
		}
		const { englishPath, banglaPath, englishName, banglaName } = req.body || {};
		if (!isValidPath(englishPath) || !englishPath.length || !isValidPath(banglaPath) || !banglaPath.length ||
			typeof englishName !== 'string' || !englishName.trim() || typeof banglaName !== 'string' || !banglaName.trim()) {
			return res.status(400).json({ message: 'English ও বাংলা tree-তে member নির্বাচন করুন। Root member delete করা যাবে না।' });
		}
		const session = client.startSession();
		try {
			await session.withTransaction(async () => {
				const enRoot = await englishTree.findOne({}, { session });
				const bnRoot = await banglaTree.findOne({}, { session });
				if (!enRoot || !bnRoot) throw new Error('TREE_NOT_INITIALIZED');
				if (!removeNodeAtPath(enRoot, englishPath, englishName) || !removeNodeAtPath(bnRoot, banglaPath, banglaName)) {
					throw new Error('MEMBER_CHANGED');
				}
				await englishTree.updateOne({ _id: enRoot._id }, { $set: { name: enRoot.name, children: enRoot.children } }, { session });
				await banglaTree.updateOne({ _id: bnRoot._id }, { $set: { name: bnRoot.name, children: bnRoot.children } }, { session });
			});
			return res.json({ message: 'Family tree থেকে member delete হয়েছে।' });
		} catch (error) {
			if (error.message === 'MEMBER_CHANGED') return res.status(409).json({ message: 'নির্বাচিত member-এর নাম বা অবস্থান বদলেছে। Tree refresh করে আবার চেষ্টা করুন।' });
			if (error.message === 'TREE_NOT_INITIALIZED') return res.status(503).json({ message: 'Database-এ family tree পাওয়া যায়নি।' });
			console.error('Family member deletion failed:', error);
			return res.status(500).json({ message: 'Family member delete করা যায়নি।' });
		} finally {
			await session.endSession();
		}
	});

	app.get('/comments', authenticate({ complete: true }), async (req, res) => res.json(await comments.find().sort({ createdAt: -1, _id: -1 }).toArray()));
	app.post('/comments', authenticate({ complete: true }), async (req, res) => {
		const comment = req.body;
		if (![comment?.name, comment?.comment].every(value => typeof value === 'string' && value.trim()) || comment.name.trim().length > 120 || comment.comment.trim().length > 2000 || (comment.number && (typeof comment.number !== 'string' || comment.number.length > 30))) {
			return res.status(400).json({ message: 'নাম ও ২০০০ অক্ষরের মধ্যে মন্তব্য দিন।' });
		}
		const createdAt = new Date();
		const result = await comments.insertOne({ name: comment.name.trim(), number: comment.number?.trim() || '', comment: comment.comment.trim(), submittedBy: req.profile._id, createdAt });
		return res.status(201).json({ _id: result.insertedId, name: comment.name.trim(), number: comment.number?.trim() || '', comment: comment.comment.trim(), createdAt });
	});
	app.delete('/comments/:id', authenticate({ complete: true, admin: true }), async (req, res) => {
		if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ message: 'সঠিক মন্তব্য নির্বাচন করুন।' });
		const result = await comments.deleteOne({ _id: new ObjectId(req.params.id) });
		if (result.deletedCount !== 1) return res.status(404).json({ message: 'মন্তব্যটি পাওয়া যায়নি।' });
		return res.json({ message: 'মন্তব্য সরানো হয়েছে।' });
	});

	app.get('/', (req, res) => res.send('Welcome to genealogy server'));
	await client.db('admin').command({ ping: 1 });
	console.log('Connected to MongoDB');
}

run().catch(error => {
	console.error('Unable to start Genealogy server:', error);
	process.exit(1);
});

app.listen(port, () => console.log(`genealogy running on port ${port}`));
