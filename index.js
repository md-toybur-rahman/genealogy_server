const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 2000;

// middleware
app.use(cors());
app.use(express.json());





const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@bookshelfcluster.p3s31ub.mongodb.net/?ssl=true&retryWrites=true&w=majority&appName=bookshelfCluster`;



const client = new MongoClient(uri, {
	serverApi: {
		version: ServerApiVersion.v1,
		strict: true,
		deprecationErrors: true,
	},
});


async function run() {
	try {
		// Connect the client to the server (optional starting in v4.7)
		await client.connect();

		const genealogyCommentCollection = client.db('Genealogy').collection('comments');


		app.get('/comments', async(req, res) => {
			const result = await genealogyCommentCollection.find().toArray();
			res.send(result);
		})

		app.post('/comments', async (req, res) => {
			const comment = req.body;
			const result = await genealogyCommentCollection.insertOne(comment);
			res.send(result)
		})







		await client.db("admin").command({ ping: 1 });
		console.log("Pinged your deployment. You successfully connected to MongoDB!");
	} catch (error) {
		console.error('Error connecting to MongoDB:', error);
	} finally {
		// Ensures that the client will close when you finish/error
		// await client.close();
	}
}
run().catch(console.dir);

app.get('/', (req, res) => {
	res.send('Welcome to genealogy server');
});

app.listen(port, () => {
	console.log(`genealogy running on port ${port}`);
});