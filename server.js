process.env.TZ = process.env.TZ || 'Asia/Jakarta';

const app = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Washing Service running at http://localhost:${PORT}`);
});

// Background work: booking reminders and sending queued WhatsApp messages.
const { notifications } = require('./src/services');
const tick = () => {
  try { notifications.queueReminders(); } catch (err) { console.error('reminders:', err.message); }
  notifications.processQueue().catch((err) => console.error('whatsapp:', err.message));
};
setInterval(tick, 60 * 1000).unref();
setTimeout(tick, 5000).unref();
if (!notifications.hasGateway()) console.log('WhatsApp: no WHATSAPP_TOKEN set — messages wait in the outbox for staff to send with one click.');
