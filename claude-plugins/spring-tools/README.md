# Spring Tools Language Server — Claude Code Plugin

A [Claude Code](https://code.claude.com) plugin that contributes the Spring Tools Language Server, exposing Spring Boot diagnostics, bean/request-mapping lookups, and other project insights to Claude Code via MCP tools.

Unlike the VS Code extension, this plugin uses the **standalone** variant of the language server which operates **without** JDT Language Server. Project classpath is computed directly via Maven and Gradle tooling; type indexing uses Jandex.

## Requirements

- Java 21+ on `PATH`
- Maven or Gradle projects in your workspace

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
- **Project insight** — bean, component, and request-mapping lookups; resolved project classpath

Via skills (invoked as `/spring-tools:<name>`, or automatically by Claude when relevant):

- **`validate`** — collects the Spring Tools diagnostics for a project and drives the fixes
- **`quickfix`** — looks up the explanation and fix instructions for a diagnostic code in `explanations/` and applies them
- **`create-spring-boot-project`** — scaffolds a new project from start.spring.io
- **`refresh`** — forces the language server to re-index the workspace from disk

Via hooks (`hooks/hooks.json`), the plugin also tracks file and project changes on disk to keep its internal index up to date. The file-change hooks fire after `Edit`/`Write` tool calls on Java/Kotlin/Groovy source files and build/config files (`.java`, `.kt`, `.kts`, `.groovy`, `.xml`, `.properties`, `.yml`, `.yaml`, `.factories`, `.gradle`) — edits to unrelated files don't trigger them. The workspace-refresh hook fires after `git` and `rm` shell commands (and their PowerShell equivalents), since those can change files without going through Claude's file tools.

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

# tests: checker behaviour (incl. negative-control fixtures), hooks/skills/manifest consistency with the MCP tools
node --test --test-reporter=spec 'claude-plugins/tools/test/*.test.mjs'
```

The GitHub Actions workflow `.github/workflows/claude-plugin-check.yml` runs the same checks for changes under `claude-plugins/`, the `*ProblemType` enums and the MCP tool sources, and validates the manifest with `claude plugin validate --strict`.

When a new diagnostic code is added to the language server:

1. Create `explanations/<CODE>.md` following the structure above; verify every fact against the reconciler that raises the code and against the current Spring documentation, and prefer the current API (state deprecation/removal versions when showing an older one).
2. Add a row to the coverage table in `research-notes/TODO_quickfixes.md`.
3. Run the checker with `--require-all --todo --links` until it passes.

## Plugin structure

```
spring-tools/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest (metadata + MCP server config)
├── launcher.js              # Node.js script that downloads the JAR (if missing) and starts Java
├── install.js               # Node.js script that downloads the JAR
├── hooks/
│   └── hooks.json           # Hooks that notify the language server of file/project changes
├── language-server/         # Populated by install.js on first run (gitignored)
│   └── spring-boot-language-server-standalone-exec.jar
├── skills/                  # Claude Code skills, namespaced as /spring-tools:<name>
│   ├── validate/
│   ├── quickfix/
│   ├── create-spring-boot-project/
│   └── refresh/
├── explanations/            # One Markdown playbook per diagnostic code (explanation + fixes)
└── README.md
```

The sibling directory `claude-plugins/tools/` (not part of the published plugin) holds `check-explanations.mjs`, `lib/plugin-config.mjs` and the `test/` suite described above.

## How it works

Claude Code parses the MCP configuration in `plugin.json` at startup. This triggers `launcher.js`, which checks if the heavy Java JAR is downloaded. If not, it executes `install.js` to download it from Spring's CDN. Then it boots the standalone Spring Tools Language Server, instructing it to expose its MCP tools over `stdio` (the language server's own LSP socket transport is disabled, since nothing in this plugin connects to it). The server indexes the project root Claude Code passes in `CLAUDE_PROJECT_DIR` and writes its log to `boot-ls.log` in the plugin's persistent data directory (`CLAUDE_PLUGIN_DATA`, normally `~/.claude/plugins/data/<plugin-id>/`).
