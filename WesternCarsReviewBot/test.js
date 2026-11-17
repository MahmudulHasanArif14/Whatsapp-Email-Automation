async function processReviewMessages(record) {
  // Do not message bookings that have not passed eligibility checks.
  if (record.eligibility !== "eligible") {
    return;
  }

  // Each channel is controlled independently.
  if (process.env.ENABLE_WHATSAPP === "true") {
    try {
      const result = await sendWhatsApp(
        record.customerPhone,
        "Thank you for travelling with Western Cars. " +
          "If you would like to share feedback, you can do so here: https://g.page/r/CW8I7lfBBbQnEBM/review",
      );

      record.whatsappStatus = result.status;
    } catch (error) {
      console.error("WhatsApp send failed:", error.message);
      record.whatsappStatus = "failed";
    }
  }

  if (process.env.ENABLE_EMAIL === "true") {
    try {
      const result = await sendReviewEmail(
        record.customerEmail,
        record.customerName,
      );

      record.emailStatus = result.status;
    } catch (error) {
      console.error("Email send failed:", error.message);
      record.emailStatus = "failed";
    }
  }

  // Call your existing JSON-store save function here.
}
