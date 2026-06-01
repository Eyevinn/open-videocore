import express from 'express';

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'open-videocore-api' });
});

// TODO: mount routers here as surfaces are implemented
// app.use('/api/v1/assets', assetsRouter);
// app.use('/api/v1/jobs', jobsRouter);
// app.use('/api/v1/search', searchRouter);

const port = parseInt(process.env.PORT ?? '8080', 10);
app.listen(port, () => {
  console.log(`open-videocore-api listening on port ${port}`);
});

export default app;
