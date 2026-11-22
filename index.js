import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

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
const payments = database.collection("payments");
const applications = database.collection("applications");

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

app.patch("/users/:id/role", async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid user ID." });
    }

    if (!["student", "tutor", "admin"].includes(role)) {
      return res.status(400).send({ message: "Invalid user role." });
    }

    const result = await users.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "User not found." });
    }

    res.send({ message: "User role updated successfully." });
  } catch (error) {
    res.status(500).send({ message: "Failed to update user role." });
  }
});

// Student API
app.get("/student/stats", async (req, res) => {
  try {
    const { studentEmail } = req.query;

    if (!studentEmail) {
      return res.status(400).send({
        message: "Student email is required.",
      });
    }

    const [
      totalApplications,
      acceptedApplications,
      pendingApplications,
      student,
    ] = await Promise.all([
      applications.countDocuments({ studentEmail }),
      applications.countDocuments({
        studentEmail,
        status: "accepted",
      }),
      applications.countDocuments({
        studentEmail,
        status: "pending",
      }),
      users.findOne({ email: studentEmail }, { projection: { plan: 1 } }),
    ]);

    if (!student) {
      return res.status(404).send({
        message: "Student not found.",
      });
    }

    res.send({
      totalApplications,
      acceptedApplications,
      pendingApplications,
      currentPlan: student.plan || "free",
    });
  } catch (error) {
    console.error("Student stats error:", error);

    res.status(500).send({
      message: "Failed to fetch student statistics.",
    });
  }
});

// Get Student Applications
app.get("/student/applications", async (req, res) => {
  try {
    const { studentEmail } = req.query;

    if (!studentEmail) {
      return res.status(400).send({
        message: "Student email is required.",
      });
    }

    const result = await applications
      .find({ studentEmail: studentEmail.toLowerCase() })
      .sort({ appliedAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Get student applications error:", error);

    res.status(500).send({
      message: "Failed to fetch student applications.",
    });
  }
});

// Cancel Student Application
app.delete("/student/applications/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { studentEmail } = req.query;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid application ID." });
    }

    if (!studentEmail) {
      return res.status(400).send({ message: "Student email is required." });
    }

    const result = await applications.deleteOne({
      _id: new ObjectId(id),
      studentEmail: studentEmail.toLowerCase(),
      status: "pending",
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: "Application not found or it can no longer be cancelled.",
      });
    }

    res.send({
      success: true,
      message: "Application cancelled successfully.",
    });
  } catch (error) {
    console.error("Cancel student application error:", error);

    res.status(500).send({
      message: "Failed to cancel application.",
    });
  }
});

// Tutor Api

// Get Tuitions
app.get("/tuitions", async (req, res) => {
  try {
    const { tutorEmail, search, subject, classLevel, mode } = req.query;

    const filter = tutorEmail
      ? { tutorEmail }
      : { approvalStatus: "approved", isActive: true };

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { subject: { $regex: search, $options: "i" } },
      ];
    }

    if (subject) filter.subject = subject;
    if (classLevel) filter.classLevel = classLevel;
    if (mode) filter.mode = mode;

    const result = await tuitions
      .find(filter)
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
      tutorEmail,
      tutorName,
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

app.patch("/tuitions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { tutorEmail, ...updates } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid tuition ID." });
    }

    if (!tutorEmail) {
      return res.status(400).send({ message: "Tutor email is required." });
    }

    const allowedFields = [
      "title",
      "subject",
      "classLevel",
      "mode",
      "location",
      "monthlyFee",
      "daysPerWeek",
      "bannerImage",
      "description",
    ];

    const updateData = {};

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateData[field] = updates[field];
      }
    }

    if (
      updateData.mode !== undefined &&
      !["Online", "Offline"].includes(updateData.mode)
    ) {
      return res.status(400).send({ message: "Invalid tuition mode." });
    }

    if (
      updateData.monthlyFee !== undefined &&
      (!Number.isFinite(Number(updateData.monthlyFee)) ||
        Number(updateData.monthlyFee) <= 0)
    ) {
      return res.status(400).send({ message: "Invalid monthly fee." });
    }

    if (
      updateData.daysPerWeek !== undefined &&
      (!Number.isInteger(Number(updateData.daysPerWeek)) ||
        Number(updateData.daysPerWeek) < 1 ||
        Number(updateData.daysPerWeek) > 7)
    ) {
      return res.status(400).send({ message: "Invalid days per week." });
    }

    if (updateData.monthlyFee !== undefined) {
      updateData.monthlyFee = Number(updateData.monthlyFee);
    }

    if (updateData.daysPerWeek !== undefined) {
      updateData.daysPerWeek = Number(updateData.daysPerWeek);
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).send({ message: "No valid fields to update." });
    }

    const result = await tuitions.updateOne(
      { _id: new ObjectId(id), tutorEmail },
      { $set: updateData },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Tuition not found or you do not own this listing.",
      });
    }

    res.send({
      success: true,
      message: "Tuition updated successfully.",
    });
  } catch (error) {
    console.error("Update tuition error:", error);
    res.status(500).send({ message: "Failed to update tuition." });
  }
});

app.patch("/tuitions/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { tutorEmail, isActive } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid tuition ID." });
    }

    if (!tutorEmail || typeof isActive !== "boolean") {
      return res.status(400).send({ message: "Invalid status information." });
    }

    const result = await tuitions.updateOne(
      { _id: new ObjectId(id), tutorEmail },
      { $set: { isActive } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "Tuition not found or you do not own this listing.",
      });
    }

    res.send({
      success: true,
      message: `Tuition ${isActive ? "activated" : "closed"} successfully.`,
    });
  } catch (error) {
    console.error("Toggle tuition error:", error);
    res.status(500).send({ message: "Failed to update tuition status." });
  }
});

app.delete("/tuitions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { tutorEmail } = req.query;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid tuition ID." });
    }

    if (!tutorEmail) {
      return res.status(400).send({ message: "Tutor email is required." });
    }

    const result = await tuitions.deleteOne({
      _id: new ObjectId(id),
      tutorEmail,
    });

    if (result.deletedCount === 0) {
      return res.status(404).send({
        message: "Tuition not found or you do not own this listing.",
      });
    }

    res.send({
      success: true,
      message: "Tuition deleted successfully.",
    });
  } catch (error) {
    console.error("Delete tuition error:", error);
    res.status(500).send({ message: "Failed to delete tuition." });
  }
});

// Admin Api
app.get("/admin/stats", async (req, res) => {
  try {
    const [
      totalUsers,
      totalTutors,
      pendingTuitions,
      approvedTuitions,
      revenueByCurrency,
    ] = await Promise.all([
      users.countDocuments(),
      users.countDocuments({ role: "tutor" }),
      tuitions.countDocuments({ approvalStatus: "pending" }),
      tuitions.countDocuments({ approvalStatus: "approved" }),
      payments
        .aggregate([
          { $match: { paymentStatus: "paid" } },
          {
            $group: {
              _id: "$currency",
              total: { $sum: "$amount" },
            },
          },
        ])
        .toArray(),
    ]);

    res.send({
      totalUsers,
      totalTutors,
      pendingTuitions,
      approvedTuitions,
      revenueByCurrency,
    });
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch admin statistics.",
    });
  }
});

app.get("/admin/tuitions", async (req, res) => {
  try {
    const result = await tuitions.find({}).sort({ createdAt: -1 }).toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch tuition posts.",
    });
  }
});

app.patch("/admin/tuitions/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { approvalStatus } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid tuition ID." });
    }

    if (!["approved", "rejected"].includes(approvalStatus)) {
      return res.status(400).send({ message: "Invalid approval status." });
    }

    const result = await tuitions.updateOne(
      { _id: new ObjectId(id) },
      { $set: { approvalStatus } },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: "Tuition not found." });
    }

    res.send({ message: "Tuition status updated successfully." });
  } catch (error) {
    res.status(500).send({
      message: "Failed to update tuition status.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`MentorLagbe is running on port: ${PORT}`);
});
