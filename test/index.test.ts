import assert from "node:assert/strict";
import test from "node:test";
import { formatAssistantProgress, getMessageText, getPiInvocation, parseMessageEnd } from "../index.js";

test("parseMessageEnd only returns message_end events", () => {
	assert.equal(parseMessageEnd(""), undefined);
	assert.equal(parseMessageEnd("not json"), undefined);
	assert.equal(parseMessageEnd(JSON.stringify({ type: "message_start" })), undefined);

	const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
	assert.deepEqual(parseMessageEnd(JSON.stringify({ type: "message_end", message })), message);
});

test("getMessageText joins text parts and ignores other content", () => {
	assert.equal(
		getMessageText({
			content: [
				{ type: "text", text: "first" },
				{ type: "toolCall", name: "read" },
				{ type: "text", text: " second" },
				{ type: "text", text: 42 },
			],
		}),
		"first second",
	);
});

test("formatAssistantProgress summarizes tools and previews text", () => {
	const text = "a".repeat(70);
	assert.equal(
		formatAssistantProgress(
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read" },
					{ type: "toolCall", name: "read" },
					{ type: "text", text },
				],
			},
			2,
		),
		`Turn 2: read (x2)\n${"a".repeat(60)}...`,
	);
});

test("getPiInvocation uses the current script when available", () => {
	const args = ["--mode", "json"];
	assert.deepEqual(
		getPiInvocation(args, {
			currentScript: "/tmp/pi.js",
			execPath: "/runtime/node",
			fileExists: () => true,
		}),
		{ command: "/runtime/node", args: ["/tmp/pi.js", "--mode", "json"] },
	);
	assert.deepEqual(args, ["--mode", "json"]);
});

test("getPiInvocation falls back to pi for generic runtimes", () => {
	assert.deepEqual(
		getPiInvocation([], {
			currentScript: undefined,
			execPath: "node",
			fileExists: () => false,
		}),
		{ command: "pi", args: [] },
	);
	assert.deepEqual(
		getPiInvocation([], {
			currentScript: undefined,
			execPath: "bun.exe",
			fileExists: () => false,
		}),
		{ command: "pi", args: [] },
	);
});

test("getPiInvocation preserves non-generic executables", () => {
	assert.deepEqual(
		getPiInvocation(["--mode"], {
			currentScript: undefined,
			execPath: "/usr/local/bin/pi",
			fileExists: () => false,
		}),
		{ command: "/usr/local/bin/pi", args: ["--mode"] },
	);
});
