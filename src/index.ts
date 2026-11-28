import { createApp } from "./api.ts";

export { GenerateJobWorkflow } from "./workflow.ts";

const app = createApp();

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
