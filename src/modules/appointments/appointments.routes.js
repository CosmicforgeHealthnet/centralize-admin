const express = require("express");
const router = express.Router();
const controller = require("./appointments.controller");
const { authenticate } = require("../../shared/middlewares/auth.middleware");
const {
  requireTier,
  readOnly,
} = require("../../shared/middlewares/rbac.middleware");

router.use(authenticate);
router.use(readOnly); // EXECUTIVE read-only

router.get("/", requireTier("EMPLOYEE"), controller.getAllAppointments);
router.get("/analytics", requireTier("EMPLOYEE"), controller.getAnalytics);
router.get(
  "/patient/:patientId",
  requireTier("EMPLOYEE"),
  controller.getPatientAppointments,
);
router.get(
  "/doctor/:doctorId",
  requireTier("EMPLOYEE"),
  controller.getDoctorAppointments,
);
router.get("/:id", requireTier("EMPLOYEE"), controller.getAppointmentById);

// Cancel — ADMIN and above only
router.patch("/:id/cancel", requireTier("ADMIN"), controller.cancelAppointment);

module.exports = router;
