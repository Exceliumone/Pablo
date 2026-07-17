import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { startHolderSweep } from "./jobs/holder-sweep.js";
import { startEventPersister } from "./jobs/event-persister.js";

const app = buildApp();

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`pablo-api listening on ${address}`);
    startHolderSweep(app.log);
    startEventPersister(app.log);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
