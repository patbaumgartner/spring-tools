# Spring Tools Language Server — Claude Code Plugin

A [Claude Code](https://code.claude.com) plugin that contributes the Spring Tools Language Server, exposing Spring Boot diagnostics, bean/request-mapping lookups, and other project insights to Claude Code via MCP tools.

Unlike the VS Code extension, this plugin uses the **standalone** variant of the language server which operates **without** JDT Language Server. Project classpath is computed directly via Maven and Gradle tooling; type indexing uses Jandex.

## Requirements

- Java 21+ — found via `SPRING_TOOLS_JAVA`, then `$JAVA_HOME/bin/java`, then `java` on `PATH` (the first candidate that reports Java 21 or newer is used)
- Maven or Gradle projects in your workspace

Optional environment variables:

| Variable | Purpose |
|---|---|
| `SPRING_TOOLS_JAVA` | Path of the `java` executable to run the language server with |
| `SPRING_TOOLS_JAVA_OPTS` | Extra JVM options, e.g. `-Xmx2g`; appended after the defaults so they take precedence |
| `SPRING_TOOLS_LS_JAR` | Run a local language server JAR instead of the downloaded one (no download happens) |
| `SPRING_TOOLS_LS_WATCH` | Set to `false` to turn off the language server's own file watcher (see [What the language server provides](#what-the-language-server-provides)); the hooks keep notifying it about Claude's edits |
| `HTTPS_PROXY` / `NO_PROXY` | The JAR download honors the usual proxy variables (`HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, lower-case variants; HTTP proxies with optional basic auth) |
| `MCP_TIMEOUT` | Claude Code's MCP startup timeout in ms; raise it if the language server is reported as failed on a slow machine |

## Usage

### 1. Add the Marketplace

First, add either the Release or Snapshot marketplace to Claude Code:

**To use the stable release:**
```bash
claude plugin marketplace add https://cdn.spring.io/spring-tools/release/claude-plugins/marketplace.json
```

**To use the bleeding-edge snapshot:**
```bash
claude plugin marketplace add https://cdn.spring.io/spring-tools/snapshot/claude-plugins/marketplace.json
```

### 2. Install the Plugin

Once the marketplace is added, install the plugin:

**If you added the stable release marketplace:**
```bash
claude plugin install spring-tools@spring-tools-marketplace
```

**If you added the snapshot marketplace:**
```bash
claude plugin install spring-tools@spring-tools-snapshots
```

### 3. Update the Plugin

When new versions of the plugin are published to the marketplace, update it by running:

```bash
claude plugin marketplace update
claude plugin update spring-tools
```

### 4. Testing the Plugin

To verify that the Spring Boot Language Server is correctly booting up and serving MCP tools to Claude Code, you must run Claude Code **interactively** (don't use the `-p` single-shot flag, as it will kill the CLI before the language server finishes initializing).

Open a Spring Boot project and start Claude Code:
```bash
claude
```

Then, ask Claude a test query to verify the MCP integration. For example:
> "Check the project diagnostics for CoffeeController.java."

Claude calls the `getProjectDiagnostics` MCP tool and summarizes the exact Spring Boot warnings and quick fixes it reports. Note that the MCP server is available within a few seconds, but the project itself only shows up in `getProjectList` once the language server has resolved the Maven/Gradle project model - a few seconds with a warm dependency cache, up to a couple of minutes on a cold one. The `validate` skill retries `getProjectList` while the list is still empty.

### 5. Local Testing

We maintain a local marketplace configuration (`claude-plugins/.claude-plugin/marketplace.json`) to make testing the plugin directly from the source tree easy.

1. Run the update script to build the standalone language server JAR and copy it into this plugin's directory (run this from the `claude-plugins` directory):
   ```bash
   ./update-local-jars.sh
   ```
2. Add the local `claude-plugins` directory as a marketplace (run this from the repository root):
   ```bash
   claude plugin marketplace add ./claude-plugins
   ```
3. Install the plugin from your new local marketplace:
   ```bash
   claude plugin install spring-tools@spring-tools-local
   ```

## Configuring language server preferences

You can customize validation severities and other language server settings on a per-project basis by placing a settings file inside the `.claude/` directory of your project. Two formats are supported and may coexist — the properties file provides the base values and the JSON file overrides them.

### Properties format (`.claude/spring-tools.properties`)

Flat `key=value` format where each key is the full dot-separated settings path. This is the simplest format to get started with:

```properties
# Category enablement toggles (AUTO / ON / OFF)
boot-java.validation.java.boot2=OFF
boot-java.validation.java.boot3=AUTO
boot-java.validation.java.boot4=ON
boot-java.validation.spel.on=ON
boot-java.validation.java.version-validation=OFF

# Per-problem severity overrides (IGNORE / HINT / INFO / WARNING / ERROR)
spring-boot.ls.problem.boot2.JAVA_PUBLIC_BEAN_METHOD=IGNORE
spring-boot.ls.problem.boot2.JAVA_AUTOWIRED_CONSTRUCTOR=IGNORE
```

### JSON format (`.claude/spring-tools.json`)

Nested JSON matching the VSCode `boot-java` / `spring-boot` configuration structure. Useful when you want to express several settings for the same category together:

```json
{
  "boot-java": {
    "validation": {
      "java": {
        "boot2": "OFF",
        "boot3": "AUTO",
        "boot4": "ON",
        "version-validation": "OFF"
      },
      "spel": { "on": "ON" }
    }
  },
  "spring-boot": {
    "ls": {
      "problem": {
        "boot2": {
          "JAVA_PUBLIC_BEAN_METHOD": "IGNORE",
          "JAVA_AUTOWIRED_CONSTRUCTOR": "IGNORE"
        }
      }
    }
  }
}
```

### Available settings

**Category enablement toggles** (`boot-java.validation.*`) accept `AUTO`, `ON`, or `OFF`. `AUTO` (the default for the `boot2`/`boot3`/`boot4` categories) applies a category only when the project's Spring Boot version matches it, `ON` forces it on for every Spring Boot project regardless of version (for example to see Boot 4 findings while still on Boot 3), and `OFF` disables it. The `spring-aot`, `spel`, `version-validation`, `data-query`, `cron` and `spring-ai` categories only support `ON`/`OFF`; the `application-properties` and `application-yaml` categories have no toggle — silence individual codes with a severity of `IGNORE` instead.

**Per-problem severity overrides** (`spring-boot.ls.problem.<category>.<code>`) accept `IGNORE`, `HINT`, `INFO`, `WARNING`, or `ERROR`.

**Per-problem parameters** (`spring-boot.ls.problem-parameters.<category>.<code>.<key>`) tune individual checks, for example `spring-boot.ls.problem-parameters.spring-ai.SPRING_AI_TOOL_DESCRIPTION_TOO_SHORT.minimum-length=40`; the version-validation category has a category-wide parameter `spring-boot.ls.problem-parameters.version-validation.use-project-build-file=false` (look up available versions on spring.io instead of the project's Maven repositories).

The full list of available categories, problem codes and parameters is embedded in the language server JAR as `problem-types.json` (inside the nested `spring-boot-language-server-*.jar`). They are the same keys used in the VSCode extension's settings, so the `boot-java.*` / `spring-boot.*` entries of `vscode-extensions/vscode-spring-boot/package.json` double as a reference.

Settings are applied once at startup. You must restart the language server for changes to take effect: restart Claude Code, or reconnect the `spring-tools-mcp` server from the `/mcp` menu.

## What the language server provides

Via MCP tools:

- **Diagnostics** — Spring-specific warnings and quick fixes (missing annotations, incorrect bean wiring, etc.), including version validation results and checks of `application.properties` / `application.yml` / `META-INF/spring.factories` (unknown or deprecated properties, type mismatches, structural errors, unsupported factories keys). Config files under test resources are only included when `boot-java.scan-java-test-sources.on=true` is set (see below)
- **Project insight** — bean, component, and request-mapping lookups; logical structure and architectural change tracking; resolved project classpath; Java and Spring Boot version; release and support information for Spring projects

Skills (invoked as `/spring-tools:<name>`, or automatically by Claude when relevant):

- **`validate`** — collects the Spring Tools diagnostics for a project and drives the fixes
- **`quickfix`** — looks up the explanation and fix instructions for a diagnostic code in `explanations/` and applies them
- **`create-spring-boot-project`** — scaffolds a new project from start.spring.io
- **`beans`** — bean definitions, injection points and usages ("where is this bean injected?", "which beans implement X?")
- **`endpoints`** — request mappings, optionally filtered by HTTP method ("which endpoints exist?")
- **`architecture`** — logical structure and stereotypes; captures a baseline and reports the structural changes since
- **`spring-versions`** — the Spring Boot version in use versus the latest releases, support windows and upcoming releases
- **`project-info`** — project list, Java version, Boot version and resolved classpath ("is this project indexed?", "which dependency provides X?")
- **`refresh`** — forces the language server to re-index the workspace from disk (or a single file) when something was missed

Agents (`agents/`) — the plugin also ships a reviewer subagent:

- **`spring-reviewer`** — a read-only Spring review of the current changes: it combines the `getProjectDiagnostics` results with the bean, endpoint and structure tools and reports blocking issues, recommendations and notes without editing anything. Invoke it explicitly ("use the spring-reviewer agent") or let Claude delegate to it.

The language server keeps its index current in two ways. It **watches** the workspace directory itself (`CLAUDE_PROJECT_DIR`; extra roots added with `/add-dir` are not watched, and neither are edits outside the project root) and re-indexes changed Java/Kotlin/Groovy, config and build files after a short quiet period — so edits made by an external editor, a code generator or a shell command show up on their own, as do Maven/Gradle projects created after the server started (e.g. by the `create-spring-boot-project` skill). Set `SPRING_TOOLS_LS_WATCH=false` to turn this off, e.g. for a huge monorepo or a workspace on a network drive; the watcher also disables itself above 20,000 directories. In addition, hooks (`hooks/hooks.json`) give the server a synchronous fast path for Claude's own actions: the file-change hooks fire after `Edit`/`Write` tool calls on Java/Kotlin/Groovy source files and build/config files (`.java`, `.kt`, `.kts`, `.groovy`, `.xml`, `.properties`, `.yml`, `.yaml`, `.factories`, `.gradle`) — edits to unrelated files don't trigger them — and the workspace-refresh hook fires after shell commands that change files without going through Claude's file tools: `git`, `rm`, `mv`, `cp`, `sed`, `patch`, `tar`, `unzip` (and `git`, `Remove-Item`, `Move-Item`, `Copy-Item`, `Expand-Archive`, `tar` in PowerShell). A `SessionStart` hook runs `install.js --if-missing` so the language server JAR is downloaded before the MCP server needs it.

## Troubleshooting

- **`spring-tools-mcp` shows as failed in `/mcp`** — on the very first start the ~100 MB JAR has to be downloaded; if that takes longer than Claude Code's MCP startup timeout the server is marked failed. Reconnect it from `/mcp` (the download continues/completes in the background) or start Claude Code again; raise `MCP_TIMEOUT` on slow connections.
- **`No Java 21+ runtime found`** on stderr — the launcher lists every candidate it tried with the version it found. Install a JDK 21+ and expose it via `PATH`, `JAVA_HOME` or `SPRING_TOOLS_JAVA`.
- **`getProjectList` is empty** — the Maven/Gradle model is still resolving (up to a couple of minutes on a cold dependency cache); the `validate` skill retries. Check with `/spring-tools:project-info`; if a project still doesn't appear (for example it lives in a directory added with `/add-dir`, outside `CLAUDE_PROJECT_DIR`), run `/spring-tools:refresh`.
- **Changes made outside Claude aren't picked up** — the watcher logs `file watcher started for <dir>` in `boot-ls.log`; if it logs `not started` instead (too many directories, unsupported file system, `SPRING_TOOLS_LS_WATCH=false`), run `/spring-tools:refresh` after external changes.
- **Download blocked by a corporate proxy** — set `HTTPS_PROXY`; the installer only downloads from `cdn.spring.io` over HTTPS and verifies the SHA-256 published next to the JAR. To install offline, download the JAR yourself and point `SPRING_TOOLS_LS_JAR` at it.
- **Logs** — `boot-ls.log` in the plugin's data directory (`~/.claude/plugins/data/<plugin-id>/`).

## Explanation playbooks

Every diagnostic the language server can report through `getProjectDiagnostics` carries a `code` (for example `JAVA_PUBLIC_BEAN_METHOD`). For each code there is one Markdown playbook `explanations/<CODE>.md` that the `quickfix` skill reads before touching the user's code. A playbook has two sections:

- `## Explanations` — what the diagnostic flags, why it matters, when the language server raises it (Spring/Boot version range, required dependency, what exactly is inspected), and a `For more details, see:` list of official documentation links.
- `## Fixes` — one or more `**Fix N: …**` blocks with prose and *Before:* / *After:* code blocks. Cross-references to other diagnostics are written as backticked codes (for example ``see `JAVA_LAMBDA_DSL` ``) and must point to an existing playbook.

The codes come from the `*ProblemType` enums of the language server (`Boot2JavaProblemType`, `Boot3JavaProblemType`, `Boot4JavaProblemType`, `SpringAotJavaProblemType`, `SpringAiProblemType`, `SpelProblemType`, `cron/CronProblemType`, `data/jpa/queries/QueryProblemType`, `properties/reconcile/ApplicationPropertiesProblemType`, `yaml/reconcile/ApplicationYamlProblemType`) plus two codes that are not enum constants: `BOOT_VERSION_VALIDATION_CODE`, which all Spring Boot version-validation diagnostics share, and `YamlSchemaProblem`, which the YAML reconciler inherits from `commons-yaml` for malformed `<<` merge keys. Coverage is tracked in [`research-notes/TODO_quickfixes.md`](../research-notes/TODO_quickfixes.md).

### Keeping the playbooks consistent

`claude-plugins/tools/` contains a Node.js checker and tests (Node 20+, no dependencies) that keep the playbooks and the plugin configuration in sync with the language server. Run them from the repository root:

```bash
# every code has a playbook, no orphan files, structure/cross-references valid, TODO table in sync
node claude-plugins/tools/check-explanations.mjs --require-all --todo

# additionally verify that every documentation link returns HTTP 200
node claude-plugins/tools/check-explanations.mjs --require-all --links

# only a subset (e.g. while writing a new playbook)
node claude-plugins/tools/check-explanations.mjs --codes JAVA_PUBLIC_BEAN_METHOD,JAVA_LAMBDA_DSL --links

# hooks, skills and agents reference only MCP tools the language server offers, every tool is reachable
# through a skill or hook, skills grant exactly the tools they document, the eval suite mocks every tool
node claude-plugins/tools/check-plugin-config.mjs

# tests: checker behaviour (incl. negative-control fixtures), hooks/skills/agents/manifest consistency with the MCP tools,
# installer (against a local mock CDN) and launcher (Java selection, JVM arguments, server instructions)
node --test --test-reporter=spec 'claude-plugins/tools/test/*.test.mjs'

# end-to-end: start launcher.js over MCP stdio like Claude Code does, index a sample project, exercise the
# diagnostics/bean/endpoint/structure tools, edit files with and without notifying the server (file watcher),
# create a project after startup and verify it is discovered (needs the JAR + Java 21+)
node claude-plugins/tools/smoke/mcp-smoke.mjs
```

The GitHub Actions workflow `.github/workflows/claude-plugin-check.yml` runs the same checks for changes under `claude-plugins/`, the `*ProblemType` enums, the MCP tool sources and the standalone language server, validates the manifest with `claude plugin validate --strict`, and runs the smoke test against a freshly built language server.

When a new MCP tool is added to the language server, give it a home: mention it in the skill that covers its use case (its `allowed-tools` list and body) or in `hooks/hooks.json`; `check-plugin-config.mjs` fails until every tool is reachable through a skill or hook.

### Behavioral evals

`evals/` holds a [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals) suite: one case per skill and for the `spring-reviewer` agent, plus a negative control (an unrelated question must not trigger any skill). Each case is a prompt phrased the way a user would type it, with graders for the result (a regex or a judged rubric) and for the path (`tool_used` on the skill and on the MCP tool it should call). The language server is not started during a run: `evals/mocks/spring-tools-mcp/` answers every MCP tool from recordings taken against the real server on the `sf7-validation` test project (`_tools.json` carries the real tool descriptions and schemas), and the `validate` and reviewer cases override `getProjectDiagnostics` with a recording that contains a `JAVA_AUTOWIRED_CONSTRUCTOR` finding.

```bash
# runs every case three times with the plugin and three times without it, judged with your Claude Code credentials
cd claude-plugins/spring-tools && claude plugin eval . --no-publish

# one case, one arm, one run - cheap while iterating on a skill description
claude plugin eval . --case validate-finds-spring-problems --runs 1 --ablation none

# re-record the mocks after the language server's tools or the fixture project changed (needs the JAR + Java 21+)
node claude-plugins/tools/evals/record-mocks.mjs
```

Every run and every `llm` grader is a model call on your account (Claude Code 2.1.269+, logged in or `ANTHROPIC_API_KEY`). `check-plugin-config.mjs` keeps the suite consistent offline: every tool has a mock, `_tools.json` matches the server's tool list, graders reference only existing tools/skills/agents, and every skill and agent has a case. The `create-project-routes-to-skill` case checks routing only — eval runs don't grant `Bash`, so the skill can't download from start.spring.io there.

When a new diagnostic code is added to the language server:

1. Create `explanations/<CODE>.md` following the structure above; verify every fact against the reconciler that raises the code and against the current Spring documentation, and prefer the current API (state deprecation/removal versions when showing an older one).
2. Add a row to the coverage table in `research-notes/TODO_quickfixes.md`.
3. Run the checker with `--require-all --todo --links` until it passes.

## Plugin structure

```
spring-tools/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest (metadata + MCP server config)
├── launcher.js              # Node.js script that picks a Java 21+ runtime, downloads the JAR (if missing) and starts it
├── install.js               # Node.js script that downloads and verifies the JAR (also run by the SessionStart hook)
├── hooks/
│   └── hooks.json           # SessionStart JAR download + hooks that notify the language server of Claude's file/project changes
├── agents/
│   └── spring-reviewer.md   # Read-only Spring review subagent built on the MCP tools
├── language-server/         # Populated by install.js on first run (gitignored)
│   └── spring-boot-language-server-standalone-exec.jar
├── skills/                  # Claude Code skills, namespaced as /spring-tools:<name>
│   ├── validate/
│   ├── quickfix/
│   ├── create-spring-boot-project/
│   ├── beans/
│   ├── endpoints/
│   ├── architecture/
│   ├── spring-versions/
│   ├── project-info/
│   └── refresh/
├── explanations/            # One Markdown playbook per diagnostic code (explanation + fixes)
├── evals/                   # claude plugin eval suite: one case per skill/agent + recorded MCP mocks (results/ is gitignored)
└── README.md
```

The sibling directory `claude-plugins/tools/` (not part of the published plugin) holds `check-explanations.mjs`, `check-plugin-config.mjs`, `lib/plugin-config.mjs`, the `test/` suite, the `smoke/mcp-smoke.mjs` end-to-end test and the `evals/record-mocks.mjs` recorder described above.

## How it works

Claude Code parses the MCP configuration in `plugin.json` at startup. This triggers `launcher.js`, which selects a Java 21+ runtime and checks if the heavy Java JAR is downloaded. If not, it downloads it from Spring's CDN (`install.js`, SHA-256 verified, written atomically; normally the `SessionStart` hook has already done this). Then it boots the standalone Spring Tools Language Server, instructing it to expose its MCP tools over `stdio` (the language server's own LSP socket transport is disabled, since nothing in this plugin connects to it) and passing server instructions that tell Claude which tools to start with. The server indexes the project root Claude Code passes in `CLAUDE_PROJECT_DIR`, watches it for changes (unless `SPRING_TOOLS_LS_WATCH=false`) and writes its log to `boot-ls.log` in the plugin's persistent data directory (`CLAUDE_PLUGIN_DATA`, normally `~/.claude/plugins/data/<plugin-id>/`).
