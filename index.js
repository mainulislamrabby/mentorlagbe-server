import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

const client = new MongoClient(process.env.MONGO_URL);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection error:", err);
    return null;
  }
}

const connectedClient = await connectToMongoDB();

if (!connectedClient) {
  throw new Error("Could not connect to MongoDB.");
}

const database = connectedClient.db("mentorlagbe");
const users = database.collection("user");
const tuitions = database.collection("tuitions");

app.get("/", (req, res) => {
  res.send(`MentorLagbe is running on port: ${PORT}`);
});

// Users API
app.get("/users", async (req, res) => {
  try {
    const result = await users.find({}).toArray();
    res.send(result);
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).send({ message: "Failed to fetch users." });
  }
});

// Get tutor's tuitions
app.get("/tuitions", async (req, res) => {
  try {
    const { tutorEmail } = req.query;

    if (!tutorEmail) {
      return res.status(400).send({
        message: "Tutor email is required.",
      });
    }

    const result = await tuitions
      .find({ tutorEmail: String(tutorEmail).trim().toLowerCase() })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Get tuitions error:", error);

    res.status(500).send({
      message: "Failed to fetch tuitions.",
    });
  }
});

// Create a tuition
app.post("/tuitions", async (req, res) => {
  try {
    const {
      title,
      subject,
      classLevel,
      mode,
      location,
      monthlyFee,
      daysPerWeek,
      bannerImage,
      description,
      tutorEmail,
      tutorName,
    } = req.body;

    const fee = Number(monthlyFee);
    const days = Number(daysPerWeek);

    if (
      !title?.trim() ||
      !subject?.trim() ||
      !classLevel?.trim() ||
      !location?.trim() ||
      !bannerImage ||
      !description?.trim() ||
      !tutorEmail?.trim() ||
      !tutorName?.trim() ||
      !Number.isFinite(fee) ||
      fee <= 0 ||
      !Number.isInteger(days) ||
      days <= 0
    ) {
      return res.status(400).send({
        message: "Please provide all required tuition information.",
      });
    }

    if (!["Online", "Offline"].includes(mode)) {
      return res.status(400).send({
        message: "Invalid tuition mode.",
      });
    }

    const tuition = {
      title: title.trim(),
      subject: subject.trim(),
      classLevel: classLevel.trim(),
      mode,
      location: location.trim(),
      monthlyFee: fee,
      daysPerWeek: days,
      bannerImage,
      description: description.trim(),
      tutorName: tutorName.trim(),
      tutorEmail: tutorEmail.trim().toLowerCase(),
      approvalStatus: "pending",
      isActive: true,
      createdAt: new Date(),
    };

    const result = await tuitions.insertOne(tuition);

    res.status(201).send({
      success: true,
      message: "Tuition posted successfully.",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Post tuition error:", error);

    res.status(500).send({
      message: "Internal server error.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`MentorLagbe is running on port: ${PORT}`);
});
