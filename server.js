process.env.TZ = process.env.TZ || 'Asia/Jakarta';

const app = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Washing Service running at http://localhost:${PORT}`);
});
