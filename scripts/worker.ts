import { runWorker } from "@/server/jobs/worker";

const controller = new AbortController();
process.on("SIGINT", () => { console.log("\nshutting down…"); controller.abort(); });
process.on("SIGTERM", () => controller.abort());

runWorker({ signal: controller.signal }).then(() => process.exit(0));
