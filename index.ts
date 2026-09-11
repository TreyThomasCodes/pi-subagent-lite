/**
 * Minimal subagent extension
 *
 * Delegates a task to a fresh pi process with an isolated context window.
 * Optionally restricts child tools, selects a model via --model, and loads startup skills via --skill flags.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import { type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const MAX_TASK_ARG_LENGTH = 4000;
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const MIN_SUBAGENT_TIMEOUT_MS = 1_000;
const MAX_SUBAGENT_TIMEOUT_MS = 86_400_000;
const RECOVERY_PROGRESS_LIMIT = 8;
const RECOVERY_CLEANUP_GRACE_MS = 5_000;
const TASKKILL_GRACE_MS = 2_000;
const MAX_DIAGNOSTIC_DETAIL_LENGTH = 240;
const DEFAULT_MAX_PROTOCOL_RECORD_CHARS = 16 * 1024 * 1024;
const MAX_STDERR_TAIL_LENGTH = 4_000;
const MAX_ALLOWED_PATHS = 100;
const MAX_ALLOWED_PATH_LENGTH = 512;
const MAX_GIT_OUTPUT_BYTES = 4_000_000;
const MAX_WORKSPACE_SNAPSHOT_PATHS = 10_000;
const MAX_WORKSPACE_FILE_BYTES = 16_000_000;
const MAX_WORKSPACE_SNAPSHOT_BYTES = 64_000_000;
const MAX_WORKSPACE_SNAPSHOT_DURATION_MS = 10_000;
const GIT_OBSERVATION_TIMEOUT_MS = 10_000;
const REPOSITORY_READ_TIMEOUT_MS = 10_000;
const MAX_REPOSITORY_READ_OUTPUT_BYTES = 50 * 1024;
const MAX_REPOSITORY_READ_OUTPUT_LINES = 2_000;
const MAX_REPOSITORY_READ_LOG_ENTRIES = 100;
const MAX_REPOSITORY_READ_REVISION_LENGTH = 128;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const ACCESS_MODES = ["read-only", "repository-read", "workspace-write"] as const;
type AccessMode = (typeof ACCESS_MODES)[number];
const DEFAULT_ACCESS_MODE: AccessMode = "workspace-write";
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const REPOSITORY_GIT_TOOLS = ["repository_git_status", "repository_git_diff", "repository_git_show", "repository_git_log"] as const;
const REPOSITORY_GITHUB_TOOLS = ["repository_github_issue_view", "repository_github_pull_request_view"] as const;
const REPOSITORY_GIT_READ_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"] as const;
const activeWorkspaceWriteLeases = new Set<string>();

function getWorkspaceLeaseKey(cwd: string): string {
	let resolved: string;
	try {
		resolved = fs.realpathSync.native(cwd);
	} catch {
		resolved = path.resolve(cwd);
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function acquireWorkspaceWriteLease(cwd: string): () => void {
	const key = getWorkspaceLeaseKey(cwd);
	if (activeWorkspaceWriteLeases.has(key)) {
		throw new Error(
			`A workspace-write subagent is already running in ${cwd}. Wait for it to finish, use access: "read-only" for parallel inspection, or run against a different working directory.`,
		);
	}
	activeWorkspaceWriteLeases.add(key);

	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeWorkspaceWriteLeases.delete(key);
	};
}

type GitWorkspace = {
	root: string;
	cwd: string;
	cwdPrefix: string;
};
type WorkspaceFileState = {
	index: string;
	file: string;
};
type WorkspaceFingerprint = {
	file: string;
	bytesRead: number;
	limitation?: string;
};
type GitWorkspaceSnapshot = {
	workspace: GitWorkspace;
	files: Map<string, WorkspaceFileState>;
	limitations: string[];
};
type WorkspaceChangeStatus = "available" | "partial" | "unavailable";
type WorkspaceChangeReport = {
	schemaVersion: 1;
	source: "git";
	status: WorkspaceChangeStatus;
	relativeTo: "cwd";
	allowedPaths: string[];
	changedPaths: string[];
	outsideAllowedPaths: string[];
	contractStatus: "within-observed-scope" | "violated" | "unknown";
	diagnostics: string[];
};
type WorkspaceObservation = {
	allowedPaths: string[];
	baseline?: GitWorkspaceSnapshot;
	initialDiagnostic?: string;
};
type SubagentRunResult = {
	output: string;
	workspaceChanges?: WorkspaceChangeReport;
};

function normalizeAllowedPaths(allowedPaths: string[] | undefined): string[] | undefined {
	if (allowedPaths === undefined) return undefined;
	if (!Array.isArray(allowedPaths)) throw new Error("allowedPaths must be an array of cwd-relative path patterns");
	if (allowedPaths.length > MAX_ALLOWED_PATHS) throw new Error(`allowedPaths may contain at most ${MAX_ALLOWED_PATHS} entries`);

	const normalized = new Set<string>();
	for (const rawPath of allowedPaths) {
		if (typeof rawPath !== "string") throw new Error("allowedPaths must contain only strings");
		if (rawPath.length === 0 || rawPath.length > MAX_ALLOWED_PATH_LENGTH) {
			throw new Error(`Each allowedPaths entry must be between 1 and ${MAX_ALLOWED_PATH_LENGTH} characters`);
		}
		if (rawPath.includes("\0") || path.isAbsolute(rawPath) || /^(?:[A-Za-z]:|\\\\|\/\/)/.test(rawPath)) {
			throw new Error(`allowedPaths entry ${JSON.stringify(rawPath)} must be a cwd-relative path pattern`);
		}
		const candidate = rawPath.replace(/\\/g, "/");
		const segments = candidate.split("/");
		if (segments.some((segment) => !segment || segment === "." || segment === ".." || (segment.includes("**") && segment !== "**"))) {
			throw new Error(`allowedPaths entry ${JSON.stringify(rawPath)} must not contain empty, dot, dot-dot, or partial ** segments`);
		}
		normalized.add(segments.join("/"));
	}
	return [...normalized].sort((a, b) => a.localeCompare(b));
}

function isPathWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toGitPath(relativePath: string): string {
	return relativePath.split(path.sep).join("/");
}

function isGitPathWithinCwd(repoPath: string, cwdPrefix: string): boolean {
	return cwdPrefix === "" || repoPath === cwdPrefix || repoPath.startsWith(`${cwdPrefix}/`);
}

function relativeToCwd(repoPath: string, cwdPrefix: string): string {
	return cwdPrefix === "" ? repoPath : repoPath.slice(cwdPrefix.length + 1);
}

function parseNulDelimited(output: Buffer): string[] {
	return output.toString("utf8").split("\0").filter((entry) => entry.length > 0);
}

async function runGit(cwd: string, args: string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdoutSize = 0;
		let stderr = "";
		let timeout: NodeJS.Timeout | undefined;
		const stdout: Buffer[] = [];
		const finish = (error?: Error, output?: Buffer) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (error) reject(error);
			else resolve(output ?? Buffer.alloc(0));
		};
		let proc: ChildProcess;
		try {
			proc = spawn("git", args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
			});
		} catch (error) {
			finish(new Error(`Git observation could not start: ${diagnosticDetail(error)}`));
			return;
		}
		timeout = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* best effort */
			}
			finish(new Error(`Git observation timed out after ${GIT_OBSERVATION_TIMEOUT_MS}ms`));
		}, GIT_OBSERVATION_TIMEOUT_MS);
		timeout.unref();
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdoutSize += chunk.length;
			if (stdoutSize > MAX_GIT_OUTPUT_BYTES) {
				try {
					proc.kill("SIGKILL");
				} catch {
					/* best effort */
				}
				finish(new Error(`Git observation exceeded ${MAX_GIT_OUTPUT_BYTES} output bytes`));
				return;
			}
			stdout.push(chunk);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendBoundedTail(stderr, chunk.toString("utf8"), MAX_DIAGNOSTIC_DETAIL_LENGTH);
		});
		proc.once("error", (error) => finish(new Error(`Git observation could not start: ${diagnosticDetail(error)}`)));
		proc.once("close", (code) => {
			if (code === 0) finish(undefined, Buffer.concat(stdout));
			else finish(new Error(`Git observation failed${code === null ? "" : ` with code ${code}`}${stderr.trim() ? `: ${diagnosticDetail(stderr)}` : ""}`));
		});
	});
}

type RepositoryReadExecutable = "git" | "gh";

function formatRepositoryReadOutput(chunks: Buffer[], outputTruncatedByBytes: boolean): string {
	const raw = Buffer.concat(chunks).toString("utf8");
	const lines = raw.split("\n");
	const outputTruncatedByLines = lines.length > MAX_REPOSITORY_READ_OUTPUT_LINES;
	const content = (outputTruncatedByLines ? lines.slice(0, MAX_REPOSITORY_READ_OUTPUT_LINES) : lines).join("\n").trimEnd();
	if (!outputTruncatedByBytes && !outputTruncatedByLines) return content || "(no output)";
	return `${content || "(no output)"}\n\n[Output truncated to ${MAX_REPOSITORY_READ_OUTPUT_LINES} lines or ${MAX_REPOSITORY_READ_OUTPUT_BYTES} bytes.]`;
}

export function classifyRepositoryReadFailure(executable: RepositoryReadExecutable, detail: string): Error {
	const normalized = detail.trim() || "unknown failure";
	if (/\benoent\b/i.test(normalized)) {
		return new Error(executable === "git" ? "Git executable is unavailable" : "GitHub CLI (gh) is unavailable");
	}
	if (executable === "git") {
		if (/not a git repository|outside repository/i.test(normalized)) {
			return new Error("Git repository read unavailable: cwd is not inside a Git worktree");
		}
		return new Error(`Git repository read failed: ${diagnosticDetail(normalized)}`);
	}
	if (/not logged into any GitHub hosts|authentication failed|bad credentials|HTTP 401|HTTP 403/i.test(normalized)) {
		return new Error(`GitHub read authentication failed: ${diagnosticDetail(normalized)}`);
	}
	if (/network|connection|timeout|timed out|could not resolve|ENOTFOUND|ECONNREFUSED|HTTP 5\d\d/i.test(normalized)) {
		return new Error(`GitHub read network request failed: ${diagnosticDetail(normalized)}`);
	}
	return new Error(`GitHub repository read failed: ${diagnosticDetail(normalized)}`);
}

async function runRepositoryReadCommand(
	executable: RepositoryReadExecutable,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) throw new Error("Repository read aborted by caller");
	return new Promise((resolve, reject) => {
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		let capturedBytes = 0;
		let outputTruncatedByBytes = false;
		let stderr = "";
		const stdout: Buffer[] = [];
		const finish = (error?: Error, output?: string) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(output ?? "(no output)");
		};
		let proc: ChildProcess;
		const stop = () => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* best effort */
			}
		};
		const onAbort = () => {
			stop();
			finish(new Error("Repository read aborted by caller"));
		};
		try {
			proc = spawn(executable, args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				env: {
					...process.env,
					GIT_OPTIONAL_LOCKS: "0",
					GIT_PAGER: "cat",
					GIT_TERMINAL_PROMPT: "0",
					GH_PAGER: "cat",
					GH_NO_UPDATE_NOTIFIER: "1",
				},
			});
		} catch (error) {
			finish(new Error(`${executable === "gh" ? "GitHub CLI (gh)" : "Git"} is unavailable: ${diagnosticDetail(error)}`));
			return;
		}
		timeout = setTimeout(() => {
			stop();
			finish(new Error(`Repository read timed out after ${REPOSITORY_READ_TIMEOUT_MS}ms`));
		}, REPOSITORY_READ_TIMEOUT_MS);
		timeout.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
		proc.stdout?.on("data", (chunk: Buffer) => {
			if (capturedBytes >= MAX_REPOSITORY_READ_OUTPUT_BYTES) {
				outputTruncatedByBytes = true;
				return;
			}
			const remaining = MAX_REPOSITORY_READ_OUTPUT_BYTES - capturedBytes;
			const captured = chunk.subarray(0, remaining);
			capturedBytes += captured.length;
			stdout.push(captured);
			if (captured.length < chunk.length) outputTruncatedByBytes = true;
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendBoundedTail(stderr, chunk.toString("utf8"), MAX_STDERR_TAIL_LENGTH);
		});
		proc.once("error", (error) => {
			const unavailable = (error as NodeJS.ErrnoException).code === "ENOENT";
			finish(unavailable
				? new Error(`${executable === "gh" ? "GitHub CLI (gh)" : "Git"} is unavailable on PATH`)
				: classifyRepositoryReadFailure(executable, diagnosticDetail(error)));
		});
		proc.once("close", (code) => {
			if (code === 0) finish(undefined, formatRepositoryReadOutput(stdout, outputTruncatedByBytes));
			else finish(classifyRepositoryReadFailure(executable, stderr || `process exited with code ${code ?? "unknown"}`));
		});
	});
}

function normalizeRepositoryReadRevision(revision: unknown): string {
	if (revision === undefined) return "HEAD";
	if (typeof revision !== "string" || revision.length === 0 || revision.length > MAX_REPOSITORY_READ_REVISION_LENGTH) {
		throw new Error(`revision must be a non-empty Git ref or object ID up to ${MAX_REPOSITORY_READ_REVISION_LENGTH} characters`);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(revision) || revision.includes("..") || revision.includes("//") || revision.startsWith("-")) {
		throw new Error("revision must be a simple Git ref or object ID, not a flag, range, pathspec, or command");
	}
	return revision;
}

function normalizeRepositoryReadCount(value: unknown): number {
	if (value === undefined) return 20;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_REPOSITORY_READ_LOG_ENTRIES) {
		throw new Error(`limit must be an integer between 1 and ${MAX_REPOSITORY_READ_LOG_ENTRIES}`);
	}
	return value;
}

function normalizeGitHubItemNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

async function getGitWorkspace(cwd: string): Promise<GitWorkspace> {
	const rootOutput = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	const root = await fs.promises.realpath(rootOutput.toString("utf8").trim());
	const resolvedCwd = await fs.promises.realpath(cwd);
	if (!isPathWithin(root, resolvedCwd)) throw new Error("Git worktree does not contain the requested working directory");
	return { root, cwd: resolvedCwd, cwdPrefix: toGitPath(path.relative(root, resolvedCwd)) };
}

function parseIndexEntries(output: Buffer): Map<string, string> {
	const entries = new Map<string, string[]>();
	for (const record of parseNulDelimited(output)) {
		const separator = record.indexOf("\t");
		if (separator === -1) throw new Error("Git index observation returned an unparseable entry");
		const metadata = record.slice(0, separator);
		const repoPath = record.slice(separator + 1);
		const pathEntries = entries.get(repoPath) ?? [];
		pathEntries.push(metadata);
		entries.set(repoPath, pathEntries);
	}
	return new Map([...entries].map(([repoPath, values]) => [repoPath, values.sort().join("|")]));
}

async function fingerprintWorkspacePath(workspace: GitWorkspace, repoPath: string, remainingBytes: number): Promise<WorkspaceFingerprint> {
	const absolutePath = path.resolve(workspace.root, ...repoPath.split("/"));
	if (!isPathWithin(workspace.root, absolutePath) || !isPathWithin(workspace.cwd, absolutePath)) {
		throw new Error(`Git observation returned a path outside the working directory: ${JSON.stringify(repoPath)}`);
	}
	try {
		const resolvedParent = await fs.promises.realpath(path.dirname(absolutePath));
		if (!isPathWithin(workspace.root, resolvedParent) || !isPathWithin(workspace.cwd, resolvedParent)) {
			throw new Error(`Git observation would traverse a symlink outside the working directory: ${JSON.stringify(repoPath)}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: "missing", bytesRead: 0 };
		throw error;
	}
	let stats: fs.Stats;
	try {
		stats = await fs.promises.lstat(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file: "missing", bytesRead: 0 };
		throw error;
	}
	const mode = stats.mode & 0o777;
	if (stats.isSymbolicLink()) {
		return { file: `symlink:${mode}:${createHash("sha256").update(await fs.promises.readlink(absolutePath)).digest("hex")}`, bytesRead: 0 };
	}
	if (stats.isDirectory()) {
		return { file: `directory:${mode}`, bytesRead: 0, limitation: `Contents of directory entry ${JSON.stringify(repoPath)} are not observed` };
	}
	if (!stats.isFile()) {
		return { file: `other:${mode}`, bytesRead: 0, limitation: `Unsupported filesystem entry ${JSON.stringify(repoPath)} is not observed` };
	}
	if (stats.size > MAX_WORKSPACE_FILE_BYTES) throw new Error(`Git observation cannot fingerprint ${JSON.stringify(repoPath)} because it exceeds ${MAX_WORKSPACE_FILE_BYTES} bytes`);
	if (stats.size > remainingBytes) throw new Error(`Git observation exceeded the ${MAX_WORKSPACE_SNAPSHOT_BYTES}-byte aggregate fingerprint limit`);
	return {
		file: `file:${mode}:${stats.size}:${createHash("sha256").update(await fs.promises.readFile(absolutePath)).digest("hex")}`,
		bytesRead: stats.size,
	};
}

async function captureGitWorkspaceSnapshot(cwd: string, existingWorkspace?: GitWorkspace): Promise<GitWorkspaceSnapshot> {
	const deadline = Date.now() + MAX_WORKSPACE_SNAPSHOT_DURATION_MS;
	const workspace = existingWorkspace ?? await getGitWorkspace(cwd);
	const [trackedOutput, indexOutput, untrackedOutput] = await Promise.all([
		runGit(workspace.root, ["ls-files", "-z"]),
		runGit(workspace.root, ["ls-files", "-s", "-z"]),
		runGit(workspace.root, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	if (Date.now() > deadline) throw new Error(`Git observation exceeded the ${MAX_WORKSPACE_SNAPSHOT_DURATION_MS}ms snapshot deadline`);
	const indexEntries = parseIndexEntries(indexOutput);
	const candidates = new Set([...parseNulDelimited(trackedOutput), ...indexEntries.keys(), ...parseNulDelimited(untrackedOutput)]);
	const repoPaths = [...candidates].filter((repoPath) => isGitPathWithinCwd(repoPath, workspace.cwdPrefix)).sort((a, b) => a.localeCompare(b));
	if (repoPaths.length > MAX_WORKSPACE_SNAPSHOT_PATHS) throw new Error(`Git observation found more than ${MAX_WORKSPACE_SNAPSHOT_PATHS} paths under the working directory`);

	const files = new Map<string, WorkspaceFileState>();
	const limitations: string[] = [];
	let remainingBytes = MAX_WORKSPACE_SNAPSHOT_BYTES;
	for (const repoPath of repoPaths) {
		if (Date.now() > deadline) throw new Error(`Git observation exceeded the ${MAX_WORKSPACE_SNAPSHOT_DURATION_MS}ms snapshot deadline`);
		const relativePath = relativeToCwd(repoPath, workspace.cwdPrefix);
		const fingerprint = await fingerprintWorkspacePath(workspace, repoPath, remainingBytes);
		if (Date.now() > deadline) throw new Error(`Git observation exceeded the ${MAX_WORKSPACE_SNAPSHOT_DURATION_MS}ms snapshot deadline`);
		remainingBytes -= fingerprint.bytesRead;
		if (fingerprint.limitation) limitations.push(fingerprint.limitation);
		files.set(relativePath, {
			index: indexEntries.get(repoPath) ?? "",
			file: fingerprint.file,
		});
	}
	return { workspace, files, limitations };
}

async function beginWorkspaceObservation(cwd: string, allowedPaths: string[]): Promise<WorkspaceObservation> {
	try {
		return { allowedPaths, baseline: await captureGitWorkspaceSnapshot(cwd) };
	} catch (error) {
		return { allowedPaths, initialDiagnostic: `Workspace observation unavailable: ${diagnosticDetail(error)}` };
	}
}

function matchesAllowedPath(pathToMatch: string, pattern: string): boolean {
	const pathSegments = pathToMatch.split("/");
	const patternSegments = pattern.split("/");
	const matchesSegment = (value: string, segment: string) => {
		const valueCharacters = [...value];
		const patternCharacters = [...segment];
		const memo = new Map<string, boolean>();
		const matches = (valueIndex: number, patternIndex: number): boolean => {
			const key = `${valueIndex}:${patternIndex}`;
			const cached = memo.get(key);
			if (cached !== undefined) return cached;
			let result: boolean;
			if (patternIndex === patternCharacters.length) {
				result = valueIndex === valueCharacters.length;
			} else if (patternCharacters[patternIndex] === "*") {
				result = matches(valueIndex, patternIndex + 1) || (valueIndex < valueCharacters.length && matches(valueIndex + 1, patternIndex));
			} else {
				result = valueIndex < valueCharacters.length
					&& (patternCharacters[patternIndex] === "?" || patternCharacters[patternIndex] === valueCharacters[valueIndex])
					&& matches(valueIndex + 1, patternIndex + 1);
			}
			memo.set(key, result);
			return result;
		};
		return matches(0, 0);
	};
	const memo = new Map<string, boolean>();
	const matches = (pathIndex: number, patternIndex: number): boolean => {
		const key = `${pathIndex}:${patternIndex}`;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		let result: boolean;
		if (patternIndex === patternSegments.length) {
			result = pathIndex === pathSegments.length;
		} else {
			const segment = patternSegments[patternIndex];
			if (segment === "**") {
				result = patternIndex === patternSegments.length - 1;
				for (let index = pathIndex; !result && index <= pathSegments.length; index++) {
					result = matches(index, patternIndex + 1);
				}
			} else {
				result = pathIndex < pathSegments.length && matchesSegment(pathSegments[pathIndex], segment) && matches(pathIndex + 1, patternIndex + 1);
			}
		}
		memo.set(key, result);
		return result;
	};
	return matches(0, 0);
}

async function captureWorkspaceChangeReport(observation: WorkspaceObservation): Promise<WorkspaceChangeReport> {
	if (!observation.baseline) {
		return {
			schemaVersion: 1, source: "git", status: "unavailable", relativeTo: "cwd", allowedPaths: observation.allowedPaths,
			changedPaths: [], outsideAllowedPaths: [], contractStatus: "unknown", diagnostics: [observation.initialDiagnostic ?? "Workspace observation did not start"],
		};
	}
	let after: GitWorkspaceSnapshot;
	try {
		after = await captureGitWorkspaceSnapshot(observation.baseline.workspace.cwd, observation.baseline.workspace);
	} catch (error) {
		return {
			schemaVersion: 1, source: "git", status: "partial", relativeTo: "cwd", allowedPaths: observation.allowedPaths,
			changedPaths: [], outsideAllowedPaths: [], contractStatus: "unknown", diagnostics: [`Workspace observation incomplete: ${diagnosticDetail(error)}`],
		};
	}
	const paths = new Set([...observation.baseline.files.keys(), ...after.files.keys()]);
	const changedPaths = [...paths].filter((relativePath) => {
		const before = observation.baseline?.files.get(relativePath);
		const current = after.files.get(relativePath);
		return before?.index !== current?.index || before?.file !== current?.file;
	}).sort((a, b) => a.localeCompare(b));
	const outsideAllowedPaths = changedPaths.filter((relativePath) => !observation.allowedPaths.some((pattern) => matchesAllowedPath(relativePath, pattern)));
	const diagnostics = [...new Set([...observation.baseline.limitations, ...after.limitations])];
	const status: WorkspaceChangeStatus = diagnostics.length > 0 ? "partial" : "available";
	return {
		schemaVersion: 1,
		source: "git",
		status,
		relativeTo: "cwd",
		allowedPaths: observation.allowedPaths,
		changedPaths,
		outsideAllowedPaths,
		contractStatus: status === "partial" ? "unknown" : outsideAllowedPaths.length > 0 ? "violated" : "within-observed-scope",
		diagnostics,
	};
}

function formatWorkspaceChangeReport(report: WorkspaceChangeReport): string {
	const formatPaths = (paths: string[]) => paths.length === 0 ? "none" : paths.map((value) => JSON.stringify(value)).join(", ");
	const lines = [
		"Workspace change report (observational):",
		`- status: ${report.status}`,
		`- contract: ${report.contractStatus}`,
		`- allowed paths: ${formatPaths(report.allowedPaths)}`,
		`- observed changed paths: ${formatPaths(report.changedPaths)}`,
		`- outside allowed paths: ${formatPaths(report.outsideAllowedPaths)}`,
	];
	for (const diagnostic of report.diagnostics) lines.push(`- diagnostic: ${diagnostic}`);
	return lines.join("\n");
}

function appendWorkspaceChangeReport(output: string, report: WorkspaceChangeReport | undefined): string {
	return report ? `${output || "(no output)"}\n\n${formatWorkspaceChangeReport(report)}` : output;
}

function appendWorkspaceChangeReportToError(error: unknown, report: WorkspaceChangeReport | undefined): Error {
	if (!report) return error instanceof Error ? error : new Error(String(error));
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`${message}\n\n${formatWorkspaceChangeReport(report)}`);
}

function getMinimalSystemPrompt(access: AccessMode, allowedPaths?: string[], githubRead = false): string {
	const accessGuidance = access === "read-only"
		? "You are in read-only access mode. Use only the available non-mutating tools and do not modify the workspace."
		: access === "repository-read"
			? `You are in repository-read access mode. Use only the available non-mutating filesystem and structured repository tools; shell, edit, and write tools are unavailable. Git${githubRead ? " and GitHub issue/pull-request" : ""} operations are fixed, parameterized read operations, not an arbitrary command interface. Do not modify the workspace or attempt to work around this boundary.`
			: "You are in workspace-write access mode. You may use the available tools to inspect and modify the workspace as the task requires.";
	const contractGuidance = allowedPaths
		? `\nAn observational allowed-path contract applies: ${allowedPaths.map((value) => JSON.stringify(value)).join(", ") || "no changes are allowed"}. Keep edits within that contract. The parent reports net observed Git changes after the run; this is not a sandbox and does not undo edits.\n`
		: "";

	return `You are a subagent running in an isolated pi process.

${accessGuidance}${contractGuidance}
Your job is to focus exclusively on the assigned task, use tools as needed, and provide a concise, evidence-based final report.

Guidelines:
- Stay focused on the task. Do not drift into unrelated work.
- Honor the task's stated objective, scope, access expectations, exclusions, verification, stopping conditions, and requested report format.
- Report work completed or findings, files changed (if any), commands and checks actually run with their outcomes, unresolved blockers, and material uncertainty.
- Distinguish observed results from assumptions, and never claim that an unrun check passed.
- Do not claim parent-level acceptance or completion beyond the evidence; the parent agent will review your report and decide next steps.`;
}

type MessageContent = {
	type?: string;
	text?: unknown;
	name?: unknown;
};

type AgentMessage = Message & { content: MessageContent[] };

type PiRuntime = {
	currentScript?: string;
	execPath: string;
	fileExists: (filePath: string) => boolean;
};

export function parseMessageEnd(line: string): AgentMessage | undefined {
	if (!line.trim()) return undefined;

	try {
		const event: unknown = JSON.parse(line);
		if (!event || typeof event !== "object") return undefined;

		const candidate = event as { type?: unknown; message?: unknown };
		if (candidate.type !== "message_end" || !candidate.message || typeof candidate.message !== "object") {
			return undefined;
		}

		return candidate.message as AgentMessage;
	} catch {
		return undefined;
	}
}

export function getMessageText(message: Pick<AgentMessage, "content">): string {
	if (!Array.isArray(message.content)) return "";

	return message.content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("");
}

function formatProgressSummary(message: AgentMessage, turnCount: number): string {
	const content = Array.isArray(message.content) ? message.content : [];
	const toolCalls = content.filter((part) => part?.type === "toolCall");
	if (toolCalls.length === 0) return `Turn ${turnCount}: thinking...`;

	const counts = new Map<string, number>();
	for (const call of toolCalls) {
		const name = typeof call.name === "string" && call.name ? call.name : "unknown tool";
		counts.set(name, (counts.get(name) || 0) + 1);
	}
	const tools = Array.from(counts.entries())
		.map(([name, count]) => (count > 1 ? `${name} (x${count})` : name))
		.join(", ");
	return `Turn ${turnCount}: ${tools}`;
}

export function formatAssistantProgress(message: AgentMessage, turnCount: number): string {
	let updateText = formatProgressSummary(message, turnCount);
	const text = getMessageText(message);
	if (text) {
		const preview = text.length > 60 ? text.slice(0, 60) + "..." : text;
		updateText += `\n${preview}`;
	}
	return updateText;
}

export function getPiInvocation(
	args: string[],
	runtime: PiRuntime = {
		currentScript: process.argv[1],
		execPath: process.execPath,
		fileExists: fs.existsSync,
	},
): { command: string; args: string[] } {
	const currentScript = runtime.currentScript;
	if (currentScript && runtime.fileExists(currentScript)) {
		return { command: runtime.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(runtime.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: runtime.execPath, args };
	}
	return { command: "pi", args };
}

type TerminationMethod = "process-group" | "taskkill" | "direct-kill";
type TerminationOutcome = "requested" | "completed" | "failed" | "timed-out";
type TerminationAttempt = {
	method: TerminationMethod;
	outcome: TerminationOutcome;
	exitCode?: number | null;
	detail?: string;
};
type TerminationReport = {
	attempts: TerminationAttempt[];
};

const terminatingProcesses = new WeakMap<ChildProcess, Promise<TerminationReport>>();

function diagnosticDetail(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	const normalized = detail.replace(/\s+/g, " ").trim();
	return normalized.length > MAX_DIAGNOSTIC_DETAIL_LENGTH
		? `${normalized.slice(0, MAX_DIAGNOSTIC_DETAIL_LENGTH)}...`
		: normalized;
}

function appendBoundedTail(existing: string, addition: string, limit: number): string {
	const combined = existing + addition;
	return combined.length > limit ? combined.slice(-limit) : combined;
}

export function getMaxProtocolRecordChars(value: string | undefined): number {
	if (value === undefined) return DEFAULT_MAX_PROTOCOL_RECORD_CHARS;
	const normalized = value.trim();
	if (!/^[1-9]\d*$/.test(normalized)) {
		throw new Error(`PI_SUBAGENT_LITE_MAX_PROTOCOL_RECORD_CHARS must be a positive safe integer; received ${JSON.stringify(value)}`);
	}
	const parsed = Number(normalized);
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`PI_SUBAGENT_LITE_MAX_PROTOCOL_RECORD_CHARS must be a positive safe integer; received ${JSON.stringify(value)}`);
	}
	return parsed;
}

export function createBoundedProtocolLineReader(maxRecordChars: number, processLine: (line: string) => void) {
	if (!Number.isSafeInteger(maxRecordChars) || maxRecordChars < 1) {
		throw new Error("maxRecordChars must be a positive safe integer");
	}

	let buffer = "";
	let discardingOversizedRecord = false;
	let oversizedRecordCount = 0;

	const push = (text: string) => {
		let cursor = 0;
		while (cursor < text.length) {
			const newlineIndex = text.indexOf("\n", cursor);
			if (discardingOversizedRecord) {
				if (newlineIndex === -1) return;
				discardingOversizedRecord = false;
				cursor = newlineIndex + 1;
				continue;
			}

			const segmentEnd = newlineIndex === -1 ? text.length : newlineIndex;
			const segmentLength = segmentEnd - cursor;
			if (buffer.length + segmentLength > maxRecordChars) {
				buffer = "";
				oversizedRecordCount++;
				if (newlineIndex === -1) {
					discardingOversizedRecord = true;
					return;
				}
				cursor = newlineIndex + 1;
				continue;
			}

			if (segmentLength > 0) buffer += text.slice(cursor, segmentEnd);
			if (newlineIndex === -1) return;
			const line = buffer;
			buffer = "";
			processLine(line);
			cursor = newlineIndex + 1;
		}
	};

	const finish = () => {
		if (!discardingOversizedRecord && buffer.trim()) processLine(buffer);
		buffer = "";
		discardingOversizedRecord = false;
	};

	return {
		push,
		finish,
		getOversizedRecordCount: () => oversizedRecordCount,
	};
}

function terminateProcessDirectly(proc: ChildProcess): TerminationAttempt {
	try {
		return { method: "direct-kill", outcome: proc.kill("SIGKILL") ? "requested" : "failed" };
	} catch (error) {
		return { method: "direct-kill", outcome: "failed", detail: diagnosticDetail(error) };
	}
}

function terminateWindowsProcessTree(proc: ChildProcess, pid: number): Promise<TerminationReport> {
	return new Promise((resolve) => {
		let settled = false;
		let taskkill: ChildProcess | undefined;
		let timeout: NodeJS.Timeout | undefined;
		const finish = (attempts: TerminationAttempt[]) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			resolve({ attempts });
		};
		const fallback = (attempt: TerminationAttempt) => finish([attempt, terminateProcessDirectly(proc)]);

		try {
			taskkill = spawn(
				path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{ stdio: "ignore", windowsHide: true },
			);
		} catch (error) {
			fallback({ method: "taskkill", outcome: "failed", detail: diagnosticDetail(error) });
			return;
		}

		taskkill.once("error", (error) => fallback({ method: "taskkill", outcome: "failed", detail: diagnosticDetail(error) }));
		taskkill.once("close", (code) => {
			if (code === 0) finish([{ method: "taskkill", outcome: "completed", exitCode: code }]);
			else fallback({ method: "taskkill", outcome: "failed", exitCode: code });
		});
		timeout = setTimeout(() => {
			try {
				taskkill?.kill("SIGKILL");
			} catch {
				/* best effort */
			}
			fallback({ method: "taskkill", outcome: "timed-out" });
		}, TASKKILL_GRACE_MS);
		timeout.unref();
	});
}

function terminateProcessTree(proc: ChildProcess): Promise<TerminationReport> {
	const existing = terminatingProcesses.get(proc);
	if (existing) return existing;

	const pid = proc.pid;
	let termination: Promise<TerminationReport>;
	if (pid === undefined) {
		termination = Promise.resolve({ attempts: [terminateProcessDirectly(proc)] });
	} else if (process.platform === "win32") {
		termination = terminateWindowsProcessTree(proc, pid);
	} else {
		try {
			process.kill(-pid, "SIGKILL");
			termination = Promise.resolve({ attempts: [{ method: "process-group", outcome: "requested" }] });
		} catch (error) {
			termination = Promise.resolve({
				attempts: [
					{ method: "process-group", outcome: "failed", detail: diagnosticDetail(error) },
					terminateProcessDirectly(proc),
				],
			});
		}
	}
	terminatingProcesses.set(proc, termination);
	return termination;
}

type RecoveryReason = "timeout" | "caller-abort" | "abnormal-exit";
type RecoveryProgress = {
	elapsedMs: number;
	turn: number;
	summary: string;
};
type RecoveryDiagnostics = {
	reason: RecoveryReason;
	elapsedMs: number;
	model?: string;
	access: AccessMode;
	timeoutMs?: number;
	maxProtocolRecordChars: number;
	oversizedProtocolRecordsSkipped: number;
	progressTail: RecoveryProgress[];
	droppedProgressEntries: number;
	assistantMessageEndObserved: boolean;
	finalAssistantResponseReceived: boolean;
	lastAssistantStopReason?: string;
	termination?: TerminationReport;
	rootExitObserved: boolean;
	cleanupDeadlineExceeded: boolean;
};

function formatRecoveryDiagnostics(diagnostics: RecoveryDiagnostics): string {
	const lines = [
		"Recovery diagnostics (bounded):",
		`- reason: ${diagnostics.reason}`,
		`- elapsed: ${diagnostics.elapsedMs}ms`,
		`- requested model: ${diagnostics.model ?? "Pi default"}`,
		`- access: ${diagnostics.access}`,
		`- requested deadline: ${diagnostics.timeoutMs === undefined ? "none" : `${diagnostics.timeoutMs}ms`}`,
		`- final child response received: ${diagnostics.finalAssistantResponseReceived ? "yes" : "no"}`,
		`- assistant message_end observed: ${diagnostics.assistantMessageEndObserved ? "yes" : "no"}`,
		"- session/log locator: unavailable (--no-session)",
	];
	if (diagnostics.oversizedProtocolRecordsSkipped > 0) {
		lines.push(`- oversized protocol records skipped: ${diagnostics.oversizedProtocolRecordsSkipped} (limit: ${diagnostics.maxProtocolRecordChars} characters per record)`);
	}
	if (diagnostics.lastAssistantStopReason) lines.push(`- latest assistant stop reason: ${diagnostics.lastAssistantStopReason}`);
	if (diagnostics.progressTail.length === 0) {
		lines.push("- progress tail: no assistant progress observed");
	} else {
		lines.push(`- progress tail: last ${diagnostics.progressTail.length} entr${diagnostics.progressTail.length === 1 ? "y" : "ies"}${diagnostics.droppedProgressEntries ? ` (${diagnostics.droppedProgressEntries} earlier entr${diagnostics.droppedProgressEntries === 1 ? "y" : "ies"} omitted)` : ""}`);
		for (const progress of diagnostics.progressTail) lines.push(`  - +${progress.elapsedMs}ms ${progress.summary}`);
	}
	if (diagnostics.termination) {
		const attempts = diagnostics.termination.attempts.map((attempt) => {
			const exitCode = attempt.exitCode === undefined ? "" : ` (exit ${attempt.exitCode ?? "unknown"})`;
			const detail = attempt.detail ? `: ${attempt.detail}` : "";
			return `${attempt.method} ${attempt.outcome}${exitCode}${detail}`;
		});
		lines.push(`- process-tree termination: ${attempts.join("; ")}`);
		lines.push(`- root process exit observed: ${diagnostics.rootExitObserved ? "yes" : "no"}`);
		lines.push("- known descendants after cleanup: unavailable (the extension has no descendant PID inventory)");
		if (diagnostics.cleanupDeadlineExceeded) lines.push("- cleanup grace period elapsed; the root process may still be running");
	} else {
		lines.push("- process-tree termination: not attempted");
	}
	return lines.join("\n");
}

class SubagentRecoveryError extends Error {
	constructor(message: string, readonly diagnostics: RecoveryDiagnostics) {
		super(`${message}\n\n${formatRecoveryDiagnostics(diagnostics)}`);
		this.name = "SubagentRecoveryError";
	}
}

type JsonRecord = Record<string, unknown>;

type DiscoveredModel = {
	selector: string;
	provider: string;
	model: string;
	name: string;
	api?: string;
	capabilities: {
		input: string[];
		images: boolean;
		reasoning: boolean;
		thinkingLevels: ThinkingLevel[];
		toolSupport: {
			additionalTools: boolean;
			grammarTools: boolean;
			toolSearch: boolean;
		};
	};
	limits: { contextTokens?: number; maxOutputTokens?: number };
	pricing?: {
		unit: "USD per million tokens";
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		tiers: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
	};
};

function isJsonRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getThinkingLevels(model: JsonRecord): ThinkingLevel[] {
	if (model.reasoning !== true) return ["off"];

	const levelMap = isJsonRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : {};
	return THINKING_LEVELS.filter((level) => {
		const mapped = levelMap[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return typeof mapped === "string";
		return true;
	});
}

function getPricing(value: unknown): DiscoveredModel["pricing"] {
	if (!isJsonRecord(value)) return undefined;
	const input = optionalNumber(value.input);
	const output = optionalNumber(value.output);
	const cacheRead = optionalNumber(value.cacheRead);
	const cacheWrite = optionalNumber(value.cacheWrite);
	if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return undefined;

	const tiers = Array.isArray(value.tiers)
		? value.tiers.flatMap((tier) => {
			if (!isJsonRecord(tier)) return [];
			const inputTokensAbove = optionalNumber(tier.inputTokensAbove);
			const tierInput = optionalNumber(tier.input);
			const tierOutput = optionalNumber(tier.output);
			const tierCacheRead = optionalNumber(tier.cacheRead);
			const tierCacheWrite = optionalNumber(tier.cacheWrite);
			return inputTokensAbove === undefined || tierInput === undefined || tierOutput === undefined || tierCacheRead === undefined || tierCacheWrite === undefined
				? []
				: [{ inputTokensAbove, input: tierInput, output: tierOutput, cacheRead: tierCacheRead, cacheWrite: tierCacheWrite }];
		})
		: [];
	return { unit: "USD per million tokens", input, output, cacheRead, cacheWrite, tiers };
}

function normalizeDiscoveredModels(models: unknown[]): DiscoveredModel[] {
	return models.flatMap((rawModel) => {
		if (!isJsonRecord(rawModel)) return [];
		const provider = optionalString(rawModel.provider);
		const model = optionalString(rawModel.id);
		if (!provider || !model) return [];

		const input = Array.isArray(rawModel.input)
			? rawModel.input.filter((type): type is string => typeof type === "string")
			: [];
		const compat = isJsonRecord(rawModel.compat) ? rawModel.compat : {};
		return [{
			selector: `${provider}/${model}`,
			provider,
			model,
			name: optionalString(rawModel.name) ?? model,
			api: optionalString(rawModel.api),
			capabilities: {
				input,
				images: input.includes("image"),
				reasoning: rawModel.reasoning === true,
				thinkingLevels: getThinkingLevels(rawModel),
				toolSupport: {
					additionalTools: compat.supportsAdditionalTools === true,
					grammarTools: compat.supportsOpenAIGrammarTools === true,
					toolSearch: compat.supportsToolSearch === true,
				},
			},
			limits: {
				contextTokens: optionalNumber(rawModel.contextWindow),
				maxOutputTokens: optionalNumber(rawModel.maxTokens),
			},
			pricing: getPricing(rawModel.cost),
		}];
	}).sort((a, b) => a.selector.localeCompare(b.selector));
}

class ModelDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelDiscoveryError";
	}
}

class PiStartupError extends ModelDiscoveryError {
	constructor(message: string) {
		super(message);
		this.name = "PiStartupError";
	}
}

async function listSubagentModels(cwd: string, signal?: AbortSignal, modelSelector?: string): Promise<string> {
	const requestId = "subagent-models";
	const args = ["--mode", "rpc", "--no-session"];
	if (modelSelector) args.push("--model", modelSelector);
	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
		env: { ...process.env, PI_SUBAGENT_LITE_DISABLE: "true" },
	});

	let buffer = "";
	let stderr = "";
	let models: unknown[] | undefined;
	let rpcError: string | undefined;
	let spawnError: Error | undefined;
	let stdinError: Error | undefined;
	let timedOut = false;
	let aborted = signal?.aborted ?? false;
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	const cancelUiRequest = (request: JsonRecord) => {
		const id = optionalString(request.id);
		const method = optionalString(request.method);
		if (aborted || !id || !["select", "confirm", "input", "editor"].includes(method ?? "") || !proc.stdin || proc.stdin.destroyed) return;
		try {
			proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, cancelled: true })}\n`);
		} catch (error) {
			stdinError = error instanceof Error ? error : new Error(String(error));
		}
	};
	const processLine = (line: string) => {
		if (!line.trim()) return;
		try {
			const message: unknown = JSON.parse(line);
			if (!isJsonRecord(message)) return;
			if (message.type === "extension_ui_request") {
				cancelUiRequest(message);
				return;
			}
			if (message.type !== "response" || message.id !== requestId) return;
			if (message.success !== true) {
				rpcError = optionalString(message.error) ?? "Model discovery request failed";
			} else {
				const data = isJsonRecord(message.data) ? message.data : undefined;
				if (Array.isArray(data?.models)) models = data.models;
				else rpcError = "Model discovery response did not include models";
			}
			void terminateProcessTree(proc);
		} catch {
			// RPC extensions may emit non-protocol output; only a correlated response matters.
		}
	};

	const exitCode = await new Promise<number>((resolve) => {
		let settled = false;
		const onAbort = () => {
			aborted = true;
			void terminateProcessTree(proc);
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			void terminateProcessTree(proc);
		}, MODEL_DISCOVERY_TIMEOUT_MS);
		timeout.unref();
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve(code);
		};

		if (aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout.on("data", (data) => {
			buffer += stdoutDecoder.write(data);
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) processLine(line);
		});
		proc.stderr.on("data", (data) => {
			stderr += stderrDecoder.write(data);
		});
		proc.once("close", (code) => {
			buffer += stdoutDecoder.end();
			stderr += stderrDecoder.end();
			if (buffer.trim()) processLine(buffer);
			finish(code ?? 0);
		});
		proc.once("error", (error) => {
			spawnError = error;
			finish(1);
		});
		if (!proc.stdin) {
			spawnError = new Error("Pi RPC stdin is unavailable");
			void terminateProcessTree(proc);
			finish(1);
			return;
		}
		proc.stdin.once("error", (error) => {
			stdinError = error;
			if (!models && !rpcError) {
				void terminateProcessTree(proc);
				finish(1);
			}
		});
		if (aborted) return;
		try {
			proc.stdin.write(`${JSON.stringify({ id: requestId, type: "get_available_models" })}\n`);
		} catch (error) {
			stdinError = error instanceof Error ? error : new Error(String(error));
			void terminateProcessTree(proc);
			finish(1);
		}
	});

	if (aborted || signal?.aborted) throw new ModelDiscoveryError("Model discovery aborted");
	if (timedOut) throw new ModelDiscoveryError(`Model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS / 1000} seconds`);
	// A correlated RPC response intentionally terminates the persistent child,
	// so process-tree termination may produce a non-zero platform exit code.
	if (exitCode !== 0 && !models && !rpcError) {
		const error = spawnError ?? new Error(stderr.trim() || stdinError?.message || `Pi exited with code ${exitCode}`);
		throw new PiStartupError(error.message);
	}
	if (rpcError) throw new ModelDiscoveryError(rpcError);
	if (!models) throw new ModelDiscoveryError(stdinError?.message || stderr.trim() || "Pi did not return a model catalog");
	return JSON.stringify({ schemaVersion: 1, source: "isolated-pi-rpc", models: normalizeDiscoveredModels(models) }, null, 2);
}

function isPiModelSelectorRejection(message: string): boolean {
	return /(?:Unknown provider|Model ".+" (?:not found|is ambiguous)|No models available)/i.test(message);
}

async function validateModelSelector(cwd: string, modelSelector: string, signal?: AbortSignal): Promise<void> {
	try {
		// Starting the same Pi runtime in RPC mode lets its native CLI resolver
		// validate exact selectors, patterns, and :thinking suffixes without
		// starting the task-bearing JSON child process.
		await listSubagentModels(cwd, signal, modelSelector);
	} catch (error) {
		if (signal?.aborted) throw new Error("Subagent aborted by caller");
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof PiStartupError && isPiModelSelectorRejection(message)) {
			throw new Error(
				`Model selector ${JSON.stringify(modelSelector)} was rejected before launching a subagent: ${message} Refresh subagent_models and choose an available selector.`,
			);
		}
		throw new Error(
			`Unable to validate model selector ${JSON.stringify(modelSelector)} because live model discovery failed: ${message} Retry subagent_models before launching another subagent.`,
		);
	}
}

async function runSubagent(
	cwd: string,
	task: string,
	skills: string[],
	access: AccessMode,
	model?: string,
	thinking?: ThinkingLevel,
	timeoutMs?: number,
	allowedPaths?: string[],
	githubRead?: boolean,
	signal?: AbortSignal,
	onUpdate?: (result: AgentToolResult) => void,
): Promise<SubagentRunResult> {
	if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < MIN_SUBAGENT_TIMEOUT_MS || timeoutMs > MAX_SUBAGENT_TIMEOUT_MS)) {
		throw new Error(`timeoutMs must be an integer between ${MIN_SUBAGENT_TIMEOUT_MS} and ${MAX_SUBAGENT_TIMEOUT_MS}`);
	}
	const normalizedAllowedPaths = normalizeAllowedPaths(allowedPaths);
	if (normalizedAllowedPaths !== undefined && access !== "workspace-write") {
		throw new Error("allowedPaths is only supported with access: \"workspace-write\"");
	}
	if (githubRead !== undefined && typeof githubRead !== "boolean") throw new Error("githubRead must be a boolean");
	if (githubRead !== undefined && access !== "repository-read") throw new Error("githubRead is only supported with access: \"repository-read\"");
	if (signal?.aborted) throw new Error("Subagent aborted by caller");
	const maxProtocolRecordChars = getMaxProtocolRecordChars(process.env.PI_SUBAGENT_LITE_MAX_PROTOCOL_RECORD_CHARS);

	const modelSelector = model?.trim();
	if (modelSelector !== undefined) {
		if (!modelSelector) throw new Error("model must be a non-empty Pi model ID or provider/model selector");
		await validateModelSelector(cwd, modelSelector, signal);
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const childTools = access === "read-only"
		? READ_ONLY_TOOLS
		: access === "repository-read"
			? [...READ_ONLY_TOOLS, ...REPOSITORY_GIT_TOOLS, ...(githubRead ? REPOSITORY_GITHUB_TOOLS : [])]
			: undefined;
	if (childTools) args.push("--tools", childTools.join(","));
	if (modelSelector) {
		// Pi performs its native resolution again when launching the task child;
		// the preflight is advisory because configuration can change in between.
		args.push("--model", modelSelector);
	}
	if (thinking) args.push("--thinking", thinking);

	for (const skill of skills) {
		args.push("--skill", skill);
	}

	const releaseWorkspaceWriteLease = access === "workspace-write"
		? acquireWorkspaceWriteLease(cwd)
		: undefined;
	let tmpDir: string | null = null;
	let workspaceObservation: WorkspaceObservation | undefined;
	let workspaceChanges: WorkspaceChangeReport | undefined;
	const finishWorkspaceObservation = async (): Promise<WorkspaceChangeReport | undefined> => {
		if (!workspaceObservation || workspaceChanges) return workspaceChanges;
		workspaceChanges = await captureWorkspaceChangeReport(workspaceObservation);
		return workspaceChanges;
	};

	try {
		if (normalizedAllowedPaths !== undefined) workspaceObservation = await beginWorkspaceObservation(cwd, normalizedAllowedPaths);
		const selection = [
			`access: ${access}`,
			modelSelector && `model: ${modelSelector}`,
			thinking && `thinking: ${thinking}`,
			timeoutMs !== undefined && `timeout: ${timeoutMs}ms`,
			githubRead && "GitHub read enabled",
			normalizedAllowedPaths !== undefined && `allowed paths: ${normalizedAllowedPaths.length}`,
		].filter(Boolean).join(", ");
		onUpdate?.({
			content: [{ type: "text", text: `Subagent running (${selection})...` }],
		});

		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		const promptFile = path.join(tmpDir, "prompt.md");
		await fs.promises.writeFile(promptFile, getMinimalSystemPrompt(access, normalizedAllowedPaths, githubRead), { encoding: "utf-8", mode: 0o600 });
		args.push("--append-system-prompt", promptFile);

		if (task.length > MAX_TASK_ARG_LENGTH) {
			const taskFile = path.join(tmpDir, "task.md");
			await fs.promises.writeFile(taskFile, task, { encoding: "utf-8", mode: 0o600 });
			args.push(`Task: Please read ${taskFile} and follow the instructions there.`);
		} else {
			args.push(`Task: ${task}`);
		}

		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
			env: {
				...process.env,
				PI_SUBAGENT_LITE_DISABLE: access === "repository-read" ? "false" : "true",
				PI_SUBAGENT_LITE_REPOSITORY_READ: access === "repository-read" ? "true" : undefined,
				PI_SUBAGENT_LITE_GITHUB_READ: access === "repository-read" && githubRead ? "true" : undefined,
			},
		});

		const startedAt = Date.now();
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		let stderr = "";
		let spawnError: Error | undefined;
		let lastAssistantText = "";
		let lastAssistantError: string | undefined;
		let lastAssistantStopReason: string | undefined;
		let assistantMessageEndObserved = false;
		let finalAssistantResponseReceived = false;
		let childExitSignal: NodeJS.Signals | null = null;
		let turnCount = 0;
		const progressTail: RecoveryProgress[] = [];
		let droppedProgressEntries = 0;
		let rootExitObserved = false;
		let cleanupDeadlineExceeded = false;
		let terminationReason: "caller-abort" | "timeout" | undefined;
		let terminationPromise: Promise<TerminationReport> | undefined;

		const recordProgress = (message: AgentMessage) => {
			turnCount++;
			const progress: RecoveryProgress = {
				elapsedMs: Math.max(0, Date.now() - startedAt),
				turn: turnCount,
				summary: diagnosticDetail(formatProgressSummary(message, turnCount)),
			};
			if (progressTail.length === RECOVERY_PROGRESS_LIMIT) {
				progressTail.shift();
				droppedProgressEntries++;
			}
			progressTail.push(progress);
			return progress;
		};
		const processLine = (line: string) => {
			const message = parseMessageEnd(line);
			if (!message || message.role !== "assistant") return;

			assistantMessageEndObserved = true;
			lastAssistantStopReason = message.stopReason;
			finalAssistantResponseReceived = message.stopReason !== "toolUse";
			// JSON mode may exit zero after a provider error. A later successful
			// response clears the error if Pi's automatic retry recovers.
			lastAssistantError = message.stopReason === "error" || message.stopReason === "aborted"
				? message.errorMessage || `Subagent request ${message.stopReason}`
				: undefined;
			const text = getMessageText(message);
			if (text && !lastAssistantError) lastAssistantText = text;

			recordProgress(message);
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: formatAssistantProgress(message, turnCount) }],
				});
			}
		};

		const protocolLineReader = createBoundedProtocolLineReader(maxProtocolRecordChars, processLine);
		const processStdout = (text: string) => protocolLineReader.push(text);
		const onStdoutData = (data: Buffer) => processStdout(stdoutDecoder.write(data));
		const onStderrData = (data: Buffer) => {
			stderr = appendBoundedTail(stderr, stderrDecoder.write(data), MAX_STDERR_TAIL_LENGTH);
		};
		proc.stdout.on("data", onStdoutData);
		proc.stderr.on("data", onStderrData);

		const disposeProcessResources = () => {
			try {
				proc.stdout.destroy();
				proc.stderr.destroy();
				proc.unref();
			} catch {
				/* best effort after a bounded cleanup failure */
			}
		};
		const buildRecoveryDiagnostics = (reason: RecoveryReason, termination?: TerminationReport): RecoveryDiagnostics => ({
			reason,
			elapsedMs: Math.max(0, Date.now() - startedAt),
			model: modelSelector,
			access,
			timeoutMs,
			maxProtocolRecordChars,
			oversizedProtocolRecordsSkipped: protocolLineReader.getOversizedRecordCount(),
			progressTail,
			droppedProgressEntries,
			assistantMessageEndObserved,
			finalAssistantResponseReceived,
			lastAssistantStopReason,
			termination,
			rootExitObserved,
			cleanupDeadlineExceeded,
		});
		const exitCode = await new Promise<number>((resolve) => {
			let settled = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			let cleanupHandle: NodeJS.Timeout | undefined;
			const terminate = (reason: "caller-abort" | "timeout") => {
				if (settled || terminationReason) return;
				terminationReason = reason;
				terminationPromise = terminateProcessTree(proc);
				cleanupHandle = setTimeout(() => {
					cleanupDeadlineExceeded = true;
					disposeProcessResources();
					finish(1);
				}, RECOVERY_CLEANUP_GRACE_MS);
				cleanupHandle.unref();
			};
			const onAbort = () => terminate("caller-abort");
			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (cleanupHandle) clearTimeout(cleanupHandle);
				signal?.removeEventListener("abort", onAbort);
				proc.removeListener("exit", onExit);
				proc.removeListener("close", onClose);
				proc.removeListener("error", onProcessError);
				proc.stdout.removeListener("data", onStdoutData);
				proc.stderr.removeListener("data", onStderrData);
				resolve(code);
			};
			const onExit = (_code: number | null, signal: NodeJS.Signals | null) => {
				rootExitObserved = true;
				childExitSignal = signal;
			};
			const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
				if (settled) return;
				if (!rootExitObserved) {
					rootExitObserved = true;
					childExitSignal = signal;
				}
				processStdout(stdoutDecoder.end());
				stderr = appendBoundedTail(stderr, stderrDecoder.end(), MAX_STDERR_TAIL_LENGTH);
				protocolLineReader.finish();
				finish(code ?? (signal ? 1 : 0));
			};
			const onProcessError = (error: Error) => {
				spawnError = error;
				finish(1);
			};

			if (timeoutMs !== undefined) {
				timeoutHandle = setTimeout(() => terminate("timeout"), timeoutMs);
				timeoutHandle.unref();
			}
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });

			proc.once("exit", onExit);
			proc.once("close", onClose);
			proc.once("error", onProcessError);
		});

		if (terminationReason) {
			const termination = await terminationPromise;
			const diagnostics = buildRecoveryDiagnostics(terminationReason, termination);
			if (terminationReason === "caller-abort") throw new SubagentRecoveryError("Subagent aborted by caller", diagnostics);
			throw new SubagentRecoveryError(`Subagent timed out after ${timeoutMs}ms`, diagnostics);
		}

		const oversizedProtocolRecordsSkipped = protocolLineReader.getOversizedRecordCount();
		const protocolFailure = oversizedProtocolRecordsSkipped > 0 && !finalAssistantResponseReceived
			? new Error(`Subagent skipped ${oversizedProtocolRecordsSkipped} protocol record${oversizedProtocolRecordsSkipped === 1 ? "" : "s"} exceeding the ${maxProtocolRecordChars}-character per-record limit without receiving a valid final response`)
			: undefined;
		const signalFailure = childExitSignal ? new Error(`Subagent terminated by signal ${childExitSignal}`) : undefined;
		const missingFinalResponseFailure = !finalAssistantResponseReceived
			? new Error("Subagent exited without a valid final assistant response")
			: undefined;
		const failure = exitCode !== 0
			? spawnError ?? protocolFailure ?? signalFailure ?? new Error(stderr.trim() || lastAssistantError || `Subagent exited with code ${exitCode}`)
			: protocolFailure ?? signalFailure ?? (lastAssistantError ? new Error(lastAssistantError) : missingFinalResponseFailure);
		if (failure) throw new SubagentRecoveryError(diagnosticDetail(failure), buildRecoveryDiagnostics("abnormal-exit"));

		const report = await finishWorkspaceObservation();
		return { output: appendWorkspaceChangeReport(lastAssistantText, report), workspaceChanges: report };
	} catch (error) {
		const report = await finishWorkspaceObservation();
		throw appendWorkspaceChangeReportToError(error, report);
	} finally {
		try {
			if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		} finally {
			releaseWorkspaceWriteLease?.();
		}
	}
}

const RepositoryGitStatusParams = Type.Object({});
const RepositoryGitDiffParams = Type.Object({
	staged: Type.Optional(Type.Boolean({ description: "When true, inspect the staged diff; otherwise inspect working-tree changes." })),
});
const RepositoryGitShowParams = Type.Object({
	revision: Type.Optional(Type.String({
		description: "A simple Git ref or object ID. Defaults to HEAD; ranges, pathspecs, and flags are rejected.",
		minLength: 1,
		maxLength: MAX_REPOSITORY_READ_REVISION_LENGTH,
	})),
});
const RepositoryGitLogParams = Type.Object({
	limit: Type.Optional(Type.Integer({
		description: `Maximum commit entries to return; defaults to 20 and is capped at ${MAX_REPOSITORY_READ_LOG_ENTRIES}.`,
		minimum: 1,
		maximum: MAX_REPOSITORY_READ_LOG_ENTRIES,
	})),
});
const RepositoryGitHubItemParams = Type.Object({
	number: Type.Integer({ description: "Issue or pull-request number in the GitHub repository associated with the current working directory.", minimum: 1 }),
});

export function registerRepositoryReadTools(pi: ExtensionAPI, enableGitHubRead = false): void {
	pi.registerTool({
		name: "repository_git_status",
		label: "Repository Git Status",
		description: "Read the current repository Git status. This runs only a fixed non-mutating Git status command; output is truncated to 2,000 lines or 50 KiB.",
		promptSnippet: "Inspect the current repository Git status without shell access",
		promptGuidelines: ["Use repository_git_status to inspect repository state; it accepts no command or flag arguments."],
		parameters: RepositoryGitStatusParams,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			return { content: [{ type: "text", text: await runRepositoryReadCommand("git", [...REPOSITORY_GIT_READ_CONFIG, "status", "--short", "--branch", "--untracked-files=normal"], ctx.cwd, signal) }] };
		},
	});
	pi.registerTool({
		name: "repository_git_diff",
		label: "Repository Git Diff",
		description: "Read a fixed non-mutating Git diff for the working tree or staging area. External diff drivers and text conversion are disabled; output is truncated to 2,000 lines or 50 KiB.",
		promptSnippet: "Inspect a repository diff without shell access",
		promptGuidelines: ["Use repository_git_diff for a working-tree or staged diff; it does not accept arbitrary Git options, refs, or paths."],
		parameters: RepositoryGitDiffParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (params.staged !== undefined && typeof params.staged !== "boolean") throw new Error("staged must be a boolean");
			const args = [...REPOSITORY_GIT_READ_CONFIG, "diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
			if (params.staged) args.push("--cached");
			return { content: [{ type: "text", text: await runRepositoryReadCommand("git", args, ctx.cwd, signal) }] };
		},
	});
	pi.registerTool({
		name: "repository_git_show",
		label: "Repository Git Show",
		description: "Read one Git revision with its metadata, statistics, and patch. The revision is a validated simple ref/object ID, never an arbitrary Git argument; output is truncated to 2,000 lines or 50 KiB.",
		promptSnippet: "Inspect a validated Git revision without shell access",
		promptGuidelines: ["Use repository_git_show to inspect a single simple ref or object ID; ranges, pathspecs, and flags are rejected."],
		parameters: RepositoryGitShowParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const revision = normalizeRepositoryReadRevision(params.revision);
			const args = [...REPOSITORY_GIT_READ_CONFIG, "show", "--no-ext-diff", "--no-textconv", "--no-renames", "--format=fuller", "--stat", "--patch", revision];
			return { content: [{ type: "text", text: await runRepositoryReadCommand("git", args, ctx.cwd, signal) }] };
		},
	});
	pi.registerTool({
		name: "repository_git_log",
		label: "Repository Git Log",
		description: "Read the latest Git history from HEAD. Only a validated entry limit is accepted; output is truncated to 2,000 lines or 50 KiB.",
		promptSnippet: "Inspect recent repository history without shell access",
		promptGuidelines: ["Use repository_git_log to inspect recent HEAD history with a bounded entry limit; it does not accept refs or arbitrary Git options."],
		parameters: RepositoryGitLogParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const limit = normalizeRepositoryReadCount(params.limit);
			return { content: [{ type: "text", text: await runRepositoryReadCommand("git", [...REPOSITORY_GIT_READ_CONFIG, "log", "--no-decorate", "--format=fuller", "--stat", `-n${limit}`], ctx.cwd, signal) }] };
		},
	});
	if (!enableGitHubRead) return;
	pi.registerTool({
		name: "repository_github_issue_view",
		label: "Repository GitHub Issue",
		description: "Read one GitHub issue for the repository associated with the current working directory. Only a positive issue number is accepted; output is truncated to 2,000 lines or 50 KiB.",
		promptSnippet: "View a GitHub issue for this repository without shell access",
		promptGuidelines: ["Use repository_github_issue_view only to read an issue by number in the current repository; it cannot list, create, edit, close, or comment on issues."],
		parameters: RepositoryGitHubItemParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const number = normalizeGitHubItemNumber(params.number, "issue number");
			const args = ["issue", "view", String(number), "--json", "number,title,state,body,labels,author,assignees,url"];
			return { content: [{ type: "text", text: await runRepositoryReadCommand("gh", args, ctx.cwd, signal) }] };
		},
	});
	pi.registerTool({
		name: "repository_github_pull_request_view",
		label: "Repository GitHub Pull Request",
		description: "Read one GitHub pull request for the repository associated with the current working directory. Only a positive pull-request number is accepted; output is truncated to 2,000 lines or 50 KiB.",
		promptSnippet: "View a GitHub pull request for this repository without shell access",
		promptGuidelines: ["Use repository_github_pull_request_view only to read a pull request by number in the current repository; it cannot list, create, edit, merge, or comment on pull requests."],
		parameters: RepositoryGitHubItemParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const number = normalizeGitHubItemNumber(params.number, "pull request number");
			const args = ["pr", "view", String(number), "--json", "number,title,state,body,author,assignees,baseRefName,headRefName,mergeStateStatus,statusCheckRollup,url"];
			return { content: [{ type: "text", text: await runRepositoryReadCommand("gh", args, ctx.cwd, signal) }] };
		},
	});
}

const SubagentParams = Type.Object({
	task: Type.String({ description: "Bounded delegation task. For non-trivial work, state the objective, scope, access expectations, exclusions, verification, stopping conditions, and requested report format." }),
	model: Type.Optional(
		Type.String({
			description: "Pi model selector returned by subagent_models, preferably provider/model. Shorthand and :thinking suffixes are supported by Pi. Omit to use the child Pi process's configured default, not the parent session's active model.",
			minLength: 1,
			pattern: "\\S",
		}),
	),
	thinking: Type.Optional(
		Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), {
			description: "Pi thinking level for the child model. Displayed with the selected model.",
		}),
	),
	access: Type.Optional(
		Type.Union(ACCESS_MODES.map((mode) => Type.Literal(mode)), {
			description: "Child tool access mode. read-only enables filesystem inspection only; repository-read adds fixed structured Git operations and optional GitHub views without shell; workspace-write preserves Pi's normal tool configuration. Defaults to workspace-write for compatibility.",
		}),
	),
	githubRead: Type.Optional(
		Type.Boolean({
			description: "Enable bounded GitHub issue and pull-request view tools for repository-read only. They inherit the child environment's gh credentials and do not expose arbitrary gh subcommands.",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			description: "Maximum child runtime in milliseconds. Omit for no extension-imposed deadline.",
			minimum: MIN_SUBAGENT_TIMEOUT_MS,
			maximum: MAX_SUBAGENT_TIMEOUT_MS,
		}),
	),
	allowedPaths: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: MAX_ALLOWED_PATH_LENGTH }), {
			description: "Optional cwd-relative path patterns for a workspace-write observational contract. Net Git changes are reported after success or failure; this is not an OS sandbox.",
			maxItems: MAX_ALLOWED_PATHS,
		}),
	),
	skills: Type.Optional(
		Type.Array(Type.String({ description: "Skill path or name to load via --skill" }), {
			description: "Optional startup skills to load into the subagent process",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_LITE_REPOSITORY_READ === "true") {
		registerRepositoryReadTools(pi, process.env.PI_SUBAGENT_LITE_GITHUB_READ === "true");
		return;
	}
	if (process.env.PI_SUBAGENT_LITE_DISABLE === "true") {
		return;
	}

	pi.registerTool({
		name: "subagent_models",
		label: "Subagent Models",
		description: "Discover the isolated Pi child process's live model catalog as structured JSON. Each model includes a selector, modality, exact thinking levels, token limits, configured cost metadata, and supported tool capabilities. Use it before selecting a subagent model in a fresh session or after model configuration changes. Compare objective requirements such as image input, context, output budget, and configured cost; do not infer unreported quality or latency.",
		promptSnippet: "Discover the child model catalog and compare objective capabilities",
		promptGuidelines: [
			"Before the first model-selected subagent call in a session, use subagent_models to obtain live selectors and capabilities. Pick explicitly based on task requirements: modality, context, output budget, supported thinking levels, and configured cost. Metadata does not establish relative quality, actual billing, or latency.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const output = await listSubagentModels(ctx.cwd, signal);
			return { content: [{ type: "text", text: output }] };
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate tasks to fresh pi subagents with isolated context windows. Read-only calls and workspace-write calls using different working directories may run in parallel; a second workspace-write call for the same working directory is rejected while the first is active. Each subagent returns a concise report when its work is done. A successful tool result is provisional: it is not proof that tests passed or that the parent should accept the work. repository-read adds fixed Git read operations and optional GitHub issue/pull-request views without arbitrary shell access; it is a tool boundary, not an OS sandbox. Optional allowedPaths contracts report bounded Git-observed net changes and out-of-scope paths without sandboxing or rolling back writes. Select an access mode and optional runtime deadline per call; workspace-write with no deadline is the compatibility default. A model and thinking level can be selected per call, and optional startup skills can be preloaded. Use subagent_models to compare the child runtime's live selectors, capabilities, limits, and configured cost metadata before selecting one in a fresh session.",
		promptSnippet: "Delegate a bounded task and receive a provisional report",
		promptGuidelines: [
			"Delegate non-trivial, self-contained tasks to subagents so you can stay focused on the overall picture.",
			"For non-trivial delegation, state the objective, scope, access expectations, exclusions, verification, stopping conditions, and desired report format in the task.",
			"Treat every successful subagent result as a provisional report, not proof that tests passed or that the task is accepted. Review the reported evidence, unresolved blockers, uncertainty, and workspace state before deciding next steps.",
			"Parallelize read-only work freely, but run at most one workspace-write subagent per working directory at a time; a concurrent same-directory writer is rejected rather than queued.",
			"repository-read exposes only fixed structured Git operations plus optional GitHub issue/pull-request views. It does not expose a shell or arbitrary command arguments, but it is a tool boundary rather than an operating-system sandbox and inherits ordinary child environment/credential visibility.",
			"For workspace-write tasks, allowedPaths can report Git-observed net changes against cwd-relative patterns. It is observational only: it does not sandbox, stop, or roll back a violating child, and unavailable Git observation must be treated as unknown scope.",
			"Before selecting a subagent model in a fresh session, use subagent_models. Select from its live catalog based on the task's concrete needs; do not guess selectors or assume the parent model is available to the child.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Pi marks thrown errors as failed tool results; returning isError does not.
			const output = await runSubagent(
				ctx.cwd,
				params.task,
				params.skills ?? [],
				params.access ?? DEFAULT_ACCESS_MODE,
				params.model,
				params.thinking,
				params.timeoutMs,
				params.allowedPaths,
				params.githubRead,
				signal,
				onUpdate,
			);
			return {
				content: [{ type: "text", text: output.output || "(no output)" }],
				details: output.workspaceChanges ? { workspaceChanges: output.workspaceChanges } : undefined,
			};
		},

		renderCall(args, theme, context) {
			const task = args.task ?? "";
			const taskPreview = task.length > 60 ? task.slice(0, 60) + "..." : task;
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("dim", taskPreview);
			const access = args.access ?? (context.argsComplete ? DEFAULT_ACCESS_MODE : undefined);
			if (access) text += ` ${theme.fg("accent", `[access: ${access}]`)}`;
			const model = args.model?.trim();
			if (model) text += ` ${theme.fg("accent", `[${model}]`)}`;
			if (args.thinking) text += ` ${theme.fg("accent", `[thinking: ${args.thinking}]`)}`;
			if (args.timeoutMs !== undefined) text += ` ${theme.fg("accent", `[timeout: ${args.timeoutMs}ms]`)}`;
			if (args.githubRead) text += ` ${theme.fg("accent", "[GitHub read]")}`;
			if (args.allowedPaths !== undefined) text += ` ${theme.fg("accent", `[allowed paths: ${args.allowedPaths.length}]`)}`;
			const skillsArr = args.skills ?? [];
			if (skillsArr.length > 0) {
				text += ` ${theme.fg("accent", `+${skillsArr.length} skills`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const output = result.content.find((c) => c.type === "text")?.text ?? "";
			if (options.isPartial) {
				return new Text(theme.fg("muted", output || "Subagent running..."), 0, 0);
			}
			const marker = context.isError ? theme.fg("error", "✗ ") : theme.fg("success", "✓ ");
			const separator = theme.fg("muted", "--- Result ---");
			const text = `${marker}${separator}\n${output}`;
			return new Text(text, 0, 0);
		},
	});
}
