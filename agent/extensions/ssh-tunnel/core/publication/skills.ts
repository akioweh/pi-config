import { basename, dirname, posix } from "node:path";
import { type ExtensionAPI, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { Resources } from "../resources.ts";
import { type Guard, once } from "./index.ts";

function publishSkillDir(resources: Resources, source: string, signal?: AbortSignal): Promise<string> {
	return once(resources, `skill:${source}`, () => resources.publishDirectory(source, { signal }));
}

export function registerSkills(pi: ExtensionAPI, guard: Guard): void {
	pi.on("before_agent_start", (event, ctx) => {
		const original = event.systemPromptOptions.skills.filter((skill) => !skill.disableModelInvocation);
		// Clear before awaiting so a failed turn cannot persist local skill paths into the transcript.
		event.systemPromptOptions.skills = [];
		if (!original.length) return;
		return guard(ctx, async (resources) => {
			const skills = [];
			for (const skill of original) {
				const baseDir = await publishSkillDir(resources, skill.baseDir, ctx.signal);
				skills.push({ ...skill, baseDir, filePath: posix.join(baseDir, basename(skill.filePath)) });
			}
			event.systemPromptOptions.skills = skills;
		});
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "user" || !Array.isArray(message.content)) return;
		const original = message.content;
		if (!original.some((block) => block.type === "text" && parseSkillBlock(block.text))) return;
		return guard(
			ctx,
			async (resources) => {
				const content = [];
				// Only rewrite blocks expanded from a registered local skill, never user-typed <skill> text.
				for (const block of original) {
					const skill = block.type === "text" ? parseSkillBlock(block.text) : null;
					if (
						block.type !== "text" ||
						!skill ||
						!pi
							.getCommands()
							.some((command) => command.source === "skill" && command.sourceInfo.path === skill.location)
					) {
						content.push(block);
						continue;
					}
					const source = dirname(skill.location);
					const directory = await publishSkillDir(resources, source, ctx.signal);
					content.push({
						...block,
						text: block.text
							.replace(`location="${skill.location}"`, `location="${posix.join(directory, basename(skill.location))}"`)
							.replace(`References are relative to ${source}.`, `References are relative to ${directory}.`),
					});
				}
				return { message: { ...message, content } };
			},
			{ message: { ...message, content: [] } },
		);
	});
}
