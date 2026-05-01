import { bootstrap } from "@embed-agent/cli";
import { startTui } from "./app.js";

const { handler } = await bootstrap();
startTui(handler);
