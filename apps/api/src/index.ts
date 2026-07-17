import { buildApp } from "./app.js";
import { env } from "./config/env.js";

const app = buildApp();

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then((address) => app.log.info(`pablo-api listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
