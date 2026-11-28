import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

// legacy-python/ and supabase/ are not part of the Worker: keep them out of fmt/lint.
const IGNORE = ["legacy-python/**", "supabase/**", "**/*.md"];

export default defineConfig({
	plugins: [cloudflare()],
	fmt: { useTabs: true, ignorePatterns: IGNORE },
	lint: {
		ignorePatterns: IGNORE,
		options: { typeAware: true, typeCheck: true },
	},
});
