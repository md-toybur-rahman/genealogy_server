const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const router = express.Router();

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
    await client.connect();

    const genealogyCommentCollection = client.db('Genealogy').collection('comments');
    const genealogyEnglishCollection = client.db('Genealogy').collection('genealogy_english');
    const genealogyBanglaCollection = client.db('Genealogy').collection('genealogy_bangla');

    router.get('/genealogy_english', async (req, res) => {
      const result = await genealogyEnglishCollection.find().toArray();
      res.send(result);
    });

    router.get('/genealogy_bangla', async (req, res) => {
      const result = await genealogyBanglaCollection.find().toArray();
      res.send(result);
    });

    router.get('/comments', async (req, res) => {
      const result = await genealogyCommentCollection.find().toArray();
      res.send(result);
    });

    router.post('/comments', async (req, res) => {
      const comment = req.body;
      const result = await genealogyCommentCollection.insertOne(comment);
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (error) {
    console.error('Error connecting to MongoDB:', error);
  }
}
run().catch(console.dir);

app.use('/.netlify/functions/genealogy', router);

module.exports.handler = serverless(app);
