import express from 'express';

const app = express();
const PORT = 3000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'api'
  });
});

app.listen(PORT, () => {
  console.log(`API running at http://localhost:${PORT}`);
});
