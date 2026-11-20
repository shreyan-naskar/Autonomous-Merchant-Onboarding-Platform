import express from 'express';

const app = express();
const PORT = 4000;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'mock-providers'
  });
});

app.get('/api/pan/verify', (_req, res) => {
  res.json({
    verified: true,
    provider: 'mock-pan'
  });
});

app.listen(PORT, () => {
  console.log(`Mock providers running at http://localhost:${PORT}`);
});
