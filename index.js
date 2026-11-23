import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from "stripe";

const app = express();
const PORT = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());

app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (error) {
      console.error("Stripe webhook signature verification failed:", error);

      return res.status(400).send({
        message: "Invalid Stripe webhook signature.",
      });
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const userId = session.metadata?.userId;
        const userEmail = session.metadata?.userEmail;
        const userName = session.metadata?.userName;
        const userRole = session.metadata?.userRole;
        const planName = session.metadata?.planName;

        if (!userId || !userEmail || !userRole || !planName) {
          return res.status(400).send({
            message: "Missing checkout metadata.",
          });
        }

        const existingPayment = await payments.findOne({
          stripeSessionId: session.id,
        });

        if (!existingPayment) {
          await payments.insertOne({
            userEmail: userEmail.toLowerCase(),
            userName: userName || "",
            userRole,
            planName,
            amount: (session.amount_total || 0) / 100,
            currency: session.currency || "usd",
            transactionId:
              session.payment_intent || session.subscription || session.id,
            stripeSessionId: session.id,
            paymentStatus: "paid",
            paidAt: new Date(),
          });
        }

        await users.updateOne(
          {
            _id: new ObjectId(userId),
          },
          {
            $set: {
              plan: "pro",
            },
          },
        );
      }

      return res.send({
        received: true,
      });
    } catch (error) {
      console.error("Stripe webhook processing error:", error);

      return res.status(500).send({
        message: "Webhook processing failed.",
      });
    }
  },
);

app.use(express.json());
const AUTH_URL = process.env.NEXT_PUBLIC_CLIENT_URL;

if (!AUTH_URL) {
  throw new Error("NEXT_PUBLIC_CLIENT_URL is not configured.");
}

const JWKS = createRemoteJWKSet(new URL("/api/auth/jwks", AUTH_URL));

const verifyToken = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      return res.status(401).send({
        message: "Authentication required.",
      });
    }

    const token = authorization.split(" ")[1];

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: AUTH_URL,
      audience: AUTH_URL,
    });

    if (!payload.sub || !ObjectId.isValid(payload.sub)) {
      return res.status(401).send({
        message: "Invalid authentication token.",
      });
    }

    const user = await users.findOne({
      _id: new ObjectId(payload.sub),
    });

    if (!user) {
      return res.status(401).send({
        message: "User not found.",
      });
    }

    req.user = {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
    };

    next();
  } catch (error) {
    return res.status(401).send({
      message: "Invalid or expired authentication token.",
    });
  }
};

const verifyStudent = (req, res, next) => {
  if (req.user?.role !== "student") {
    return res.status(403).send({
      message: "Only students can perform this action.",
    });
  }

  next();
};

const verifyTutor = (req, res, next) => {
  if (req.user?.role !== "tutor") {
    return res.status(403).send({
      message: "Only tutors can perform this action.",
    });
  }

  next();
};

const verifyAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).send({
      message: "Admin access required.",
    });
  }

  next();
};

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

await payments.createIndex(
  {
    stripeSessionId: 1,
  },
  {
    unique: true,
  },
);

await applications.createIndex(
  {
    tuitionId: 1,
    studentEmail: 1,
  },
  {
    unique: true,
  },
);

app.get("/", (req, res) => {
  res.send(`MentorLagbe is running on port: ${PORT}`);
});

app.post("/stripe/create-checkout-session", verifyToken, async (req, res) => {
  try {
    if (req.user.role !== "student" && req.user.role !== "tutor") {
      return res.status(403).send({
        message: "Only students and tutors can subscribe to Pro.",
      });
    }

    const user = await users.findOne({
      _id: new ObjectId(req.user.id),
    });

    if (!user) {
      return res.status(404).send({
        message: "User not found.",
      });
    }

    if (user.plan === "pro") {
      return res.status(400).send({
        message: "You are already subscribed to Pro.",
      });
    }

    const priceId =
      req.user.role === "student"
        ? process.env.STRIPE_STUDENT_PRICE_ID
        : process.env.STRIPE_TUTOR_PRICE_ID;

    const planName =
      req.user.role === "student" ? "Pro Student Plan" : "Pro Tutor Plan";

    if (!priceId) {
      return res.status(500).send({
        message: "Stripe price is not configured.",
      });
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],

      mode: "subscription",

      customer_email: req.user.email,

      success_url: `${process.env.NEXT_PUBLIC_CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,

      cancel_url: `${process.env.NEXT_PUBLIC_CLIENT_URL}/payment/cancel`,

      metadata: {
        userId: req.user.id,
        userEmail: req.user.email,
        userName: req.user.name,
        userRole: req.user.role,
        planName,
      },
    });

    return res.send({
      success: true,
      url: session.url,
    });
  } catch (error) {
    console.error("Create Stripe checkout error:", error);

    return res.status(500).send({
      message: "Failed to create Stripe checkout session.",
    });
  }
});

app.post("/applications", verifyToken, verifyStudent, async (req, res) => {
  try {
    const { tuitionId, studentPhone, preferredSchedule, studentNote } =
      req.body;

    if (
      !tuitionId ||
      !ObjectId.isValid(tuitionId) ||
      !studentPhone?.trim() ||
      !preferredSchedule?.trim()
    ) {
      return res.status(400).send({
        message: "Please provide all required application information.",
      });
    }

    const tuition = await tuitions.findOne({
      _id: new ObjectId(tuitionId),
      approvalStatus: "approved",
      isActive: true,
    });

    if (!tuition) {
      return res.status(404).send({
        message: "Tuition not found or is no longer available.",
      });
    }

    const studentEmail = req.user.email.toLowerCase();

    const existingApplication = await applications.findOne({
      tuitionId,
      studentEmail,
    });

    if (existingApplication) {
      return res.status(409).send({
        message: "You have already applied for this tuition.",
      });
    }

    const application = {
      tuitionId,
      tuitionTitle: tuition.title,
      subject: tuition.subject,
      monthlyFee: tuition.monthlyFee,
      tutorEmail: tuition.tutorEmail.toLowerCase(),
      studentName: req.user.name,
      studentEmail,
      studentPhone: studentPhone.trim(),
      preferredSchedule: preferredSchedule.trim(),
      studentNote: studentNote?.trim() || "",
      status: "pending",
      appliedAt: new Date(),
    };

    const result = await applications.insertOne(application);

    res.status(201).send({
      success: true,
      message: "Application submitted successfully.",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Submit application error:", error);

    res.status(500).send({
      message: "Failed to submit application.",
    });
  }
});

// Profile API

app.get("/profile", verifyToken, async (req, res) => {
  try {
    const user = await users.findOne(
      {
        _id: new ObjectId(req.user.id),
      },
      {
        projection: {
          name: 1,
          email: 1,
          image: 1,
          phone: 1,
          bio: 1,
          role: 1,
          plan: 1,
        },
      },
    );

    if (!user) {
      return res.status(404).send({
        message: "User profile not found.",
      });
    }

    res.send(user);
  } catch (error) {
    console.error("Get profile error:", error);

    res.status(500).send({
      message: "Failed to fetch profile.",
    });
  }
});

app.patch("/profile", verifyToken, async (req, res) => {
  try {
    const { name, phone, bio, image } = req.body;

    if (!name?.trim()) {
      return res.status(400).send({
        message: "Name is required.",
      });
    }

    const updateData = {
      name: name.trim(),
      phone: phone?.trim() || "",
      bio: bio?.trim() || "",
      image: image?.trim() || "",
      updatedAt: new Date(),
    };

    const result = await users.updateOne(
      {
        _id: new ObjectId(req.user.id),
      },
      {
        $set: updateData,
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message: "User not found.",
      });
    }

    res.send({
      success: true,
      message: "Profile updated successfully.",
    });
  } catch (error) {
    console.error("Update profile error:", error);

    res.status(500).send({
      message: "Failed to update profile.",
    });
  }
});

app.get("/auth-test", verifyToken, (req, res) => {
  res.send({
    message: "Authentication successful.",
    user: req.user,
  });
});

// Get all users - Admin only
app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await users
      .find(
        {},
        {
          projection: {
            name: 1,
            email: 1,
            image: 1,
            role: 1,
            plan: 1,
          },
        },
      )
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).send({ message: "Failed to fetch users." });
  }
});

// Update user role - Admin only
app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
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
    console.error("Update user role error:", error);
    res.status(500).send({ message: "Failed to update user role." });
  }
});

// Get Student Applications

app.get(
  "/student/applications",
  verifyToken,
  verifyStudent,
  async (req, res) => {
    try {
      const studentEmail = req.user.email.toLowerCase();

      const result = await applications
        .find({ studentEmail })
        .sort({ appliedAt: -1 })
        .toArray();

      res.send(result);
    } catch (error) {
      console.error("Get student applications error:", error);
      res.status(500).send({
        message: "Failed to fetch student applications.",
      });
    }
  },
);

app.get("/student/stats", verifyToken, verifyStudent, async (req, res) => {
  try {
    const studentEmail = req.user.email.toLowerCase();

    const [
      totalApplications,
      acceptedApplications,
      pendingApplications,
      student,
    ] = await Promise.all([
      applications.countDocuments({ studentEmail }),
      applications.countDocuments({ studentEmail, status: "accepted" }),
      applications.countDocuments({ studentEmail, status: "pending" }),
      users.findOne(
        { _id: new ObjectId(req.user.id) },
        { projection: { plan: 1 } },
      ),
    ]);

    if (!student) {
      return res.status(404).send({ message: "Student not found." });
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

// Cancel Student Application

app.delete(
  "/student/applications/:id",
  verifyToken,
  verifyStudent,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid application ID.",
        });
      }

      const result = await applications.deleteOne({
        _id: new ObjectId(id),
        studentEmail: req.user.email.toLowerCase(),
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
  },
);

// Tutor Applications

// Get all applications for the logged-in tutor
app.get("/tutor/applications", verifyToken, verifyTutor, async (req, res) => {
  const tutorEmail = req.user.email.toLowerCase();

  const result = await applications
    .find({ tutorEmail })
    .sort({ appliedAt: -1 })
    .toArray();

  res.send(result);
});

// Update application status
app.patch(
  "/tutor/applications/:id/status",
  verifyToken,
  verifyTutor,
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid application ID.",
      });
    }

    if (!["accepted", "rejected"].includes(status)) {
      return res.status(400).send({
        message: "Invalid application status.",
      });
    }

    const tutorEmail = req.user.email.toLowerCase();

    const result = await applications.updateOne(
      {
        _id: new ObjectId(id),
        tutorEmail,
        status: "pending",
      },
      {
        $set: {
          status,
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({
        message:
          "Application not found, already processed, or you do not own this application.",
      });
    }

    res.send({
      success: true,
      message: `Application ${status} successfully.`,
    });
  },
);

// Student: Submit a review for an accepted tuition
app.post(
  "/tuitions/:id/reviews",
  verifyToken,
  verifyStudent,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { rating, feedback } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid tuition ID.",
        });
      }

      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).send({
          message: "Rating must be between 1 and 5.",
        });
      }

      if (
        typeof feedback !== "string" ||
        !feedback.trim() ||
        feedback.trim().length > 1000
      ) {
        return res.status(400).send({
          message: "Feedback is required and must be under 1000 characters.",
        });
      }

      const tuitionId = id;
      const studentEmail = req.user.email.toLowerCase();

      const application = await applications.findOne({
        tuitionId,
        studentEmail,
        status: "accepted",
      });

      if (!application) {
        return res.status(403).send({
          message: "Only students with accepted applications can review.",
        });
      }

      const tuition = await tuitions.findOne({
        _id: new ObjectId(id),
      });

      if (!tuition) {
        return res.status(404).send({
          message: "Tuition not found.",
        });
      }

      const existingReview = (tuition.reviews || []).some(
        (review) => review.studentEmail === studentEmail,
      );

      if (existingReview) {
        return res.status(409).send({
          message: "You have already reviewed this tuition.",
        });
      }

      const review = {
        studentName: req.user.name,
        studentEmail,
        rating,
        feedback: feedback.trim(),
        createdAt: new Date(),
      };

      await tuitions.updateOne(
        {
          _id: new ObjectId(id),
        },
        {
          $push: {
            reviews: review,
          },
        },
      );

      return res.status(201).send({
        success: true,
        message: "Review submitted successfully.",
      });
    } catch (error) {
      console.error("Submit tuition review error:", error);

      return res.status(500).send({
        message: "Failed to submit review.",
      });
    }
  },
);

// Tutor Api


app.get("/tutor/stats", verifyToken, verifyTutor, async (req, res) => {
  try {
    const tutorEmail = req.user.email.toLowerCase();

    const [
      totalTuitions,
      activeApprovedTuitions,
      totalApplicants,
      tutor,
    ] = await Promise.all([
      tuitions.countDocuments({ tutorEmail }),

      tuitions.countDocuments({
        tutorEmail,
        approvalStatus: "approved",
        isActive: true,
      }),

      applications.countDocuments({ tutorEmail }),

      users.findOne(
        { _id: new ObjectId(req.user.id) },
        { projection: { plan: 1 } },
      ),
    ]);

    if (!tutor) {
      return res.status(404).send({
        message: "Tutor not found.",
      });
    }

    res.send({
      totalTuitions,
      activeApprovedTuitions,
      totalApplicants,
      currentPlan: tutor.plan || "free",
    });
  } catch (error) {
    console.error("Tutor stats error:", error);

    res.status(500).send({
      message: "Failed to fetch tutor statistics.",
    });
  }
});

// Public: Browse approved and active tuitions with pagination
app.get("/tuitions", async (req, res) => {
  try {
    const { search, subject, classLevel, mode } = req.query;

    // Pagination
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      24,
      Math.max(1, parseInt(req.query.limit, 10) || 6),
    );
    const skip = (page - 1) * limit;

    // Filters
    const filter = {
      approvalStatus: "approved",
      isActive: true,
    };

    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: "i" } },
        { subject: { $regex: search, $options: "i" } },
      ];
    }

    if (subject) filter.subject = subject;
    if (classLevel) filter.classLevel = classLevel;
    if (mode) filter.mode = mode;

    // Fetch paginated results and total count
    const [result, total] = await Promise.all([
      tuitions
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),

      tuitions.countDocuments(filter),
    ]);

    res.send({
      tuitions: result,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Browse tuitions error:", error);

    res.status(500).send({
      message: "Failed to fetch tuitions.",
    });
  }
});


// Private: Get only the logged-in tutor's tuitions
app.get("/tutor/tuitions", verifyToken, verifyTutor, async (req, res) => {
  try {
    const result = await tuitions
      .find({
        tutorEmail: req.user.email.toLowerCase(),
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Get tutor tuitions error:", error);
    res.status(500).send({
      message: "Failed to fetch your tuitions.",
    });
  }
});



// Public: Get approved tuition details
app.get("/tuitions/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid tuition ID.",
      });
    }

    const tuition = await tuitions.findOne({
      _id: new ObjectId(id),
      approvalStatus: "approved",
      isActive: true,
    });

    if (!tuition) {
      return res.status(404).send({
        message: "Tuition not found or unavailable.",
      });
    }

    res.send(tuition);
  } catch (error) {
    console.error("Get tuition details error:", error);
    res.status(500).send({
      message: "Failed to fetch tuition details.",
    });
  }
});


app.post("/tuitions", verifyToken, verifyTutor, async (req, res) => {
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
    } = req.body;

    const fee = Number(monthlyFee);
    const days = Number(daysPerWeek);

    if (
      !title?.trim() ||
      !subject?.trim() ||
      !classLevel?.trim() ||
      !location?.trim() ||
      !bannerImage?.trim() ||
      !description?.trim() ||
      !Number.isFinite(fee) ||
      fee <= 0 ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 7
    ) {
      return res.status(400).send({
        message: "Please provide valid tuition information.",
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
      bannerImage: bannerImage.trim(),
      description: description.trim(),

      // Identity comes from the verified JWT user
      tutorName: req.user.name,
      tutorEmail: req.user.email.toLowerCase(),

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
      message: "Failed to create tuition.",
    });
  }
});



app.patch("/tuitions/:id", verifyToken, verifyTutor, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid tuition ID.",
      });
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

    if (updateData.mode !== undefined &&
        !["Online", "Offline"].includes(updateData.mode)) {
      return res.status(400).send({
        message: "Invalid tuition mode.",
      });
    }

    if (updateData.monthlyFee !== undefined) {
      const fee = Number(updateData.monthlyFee);

      if (!Number.isFinite(fee) || fee <= 0) {
        return res.status(400).send({
          message: "Invalid monthly fee.",
        });
      }

      updateData.monthlyFee = fee;
    }

    if (updateData.daysPerWeek !== undefined) {
      const days = Number(updateData.daysPerWeek);

      if (!Number.isInteger(days) || days < 1 || days > 7) {
        return res.status(400).send({
          message: "Invalid days per week.",
        });
      }

      updateData.daysPerWeek = days;
    }

    for (const field of [
      "title",
      "subject",
      "classLevel",
      "location",
      "bannerImage",
      "description",
    ]) {
      if (updateData[field] !== undefined) {
        if (
          typeof updateData[field] !== "string" ||
          !updateData[field].trim()
        ) {
          return res.status(400).send({
            message: `Invalid ${field}.`,
          });
        }

        updateData[field] = updateData[field].trim();
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).send({
        message: "No valid fields to update.",
      });
    }

    updateData.updatedAt = new Date();

    const result = await tuitions.updateOne(
      {
        _id: new ObjectId(id),
        tutorEmail: req.user.email.toLowerCase(),
      },
      {
        $set: updateData,
      },
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
    res.status(500).send({
      message: "Failed to update tuition.",
    });
  }
});



// Activate or deactivate a tutor's own tuition
app.patch(
  "/tuitions/:id/status",
  verifyToken,
  verifyTutor,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { isActive } = req.body;

      if (!ObjectId.isValid(id)) {
        return res.status(400).send({
          message: "Invalid tuition ID.",
        });
      }

      if (typeof isActive !== "boolean") {
        return res.status(400).send({
          message: "Invalid tuition status.",
        });
      }

      const result = await tuitions.updateOne(
        {
          _id: new ObjectId(id),
          tutorEmail: req.user.email.toLowerCase(),
        },
        {
          $set: {
            isActive,
            updatedAt: new Date(),
          },
        },
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
      res.status(500).send({
        message: "Failed to update tuition status.",
      });
    }
  },
);

// Delete a tutor's own tuition
app.delete("/tuitions/:id", verifyToken, verifyTutor, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({
        message: "Invalid tuition ID.",
      });
    }

    const result = await tuitions.deleteOne({
      _id: new ObjectId(id),
      tutorEmail: req.user.email.toLowerCase(),
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
    res.status(500).send({
      message: "Failed to delete tuition.",
    });
  }
});


// Admin Api
app.get("/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
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

app.get("/admin/tuitions", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await tuitions.find({}).sort({ createdAt: -1 }).toArray();

    res.send(result);
  } catch (error) {
    res.status(500).send({
      message: "Failed to fetch tuition posts.",
    });
  }
});

app.patch(
  "/admin/tuitions/:id/status",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
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
  },
);

app.get("/admin/transactions", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await payments
      .find({
        paymentStatus: "paid",
      })
      .sort({
        paidAt: -1,
      })
      .toArray();

    res.send(result);
  } catch (error) {
    console.error("Get transactions error:", error);

    res.status(500).send({
      message: "Failed to fetch transactions.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`MentorLagbe is running on port: ${PORT}`);
});
