---
name: quickfix
description: Retrieves the explanation and fix instructions for a specific Spring Boot diagnostic error code and applies the fix to a specific file. Use this when you encounter a Spring Boot warning or error and need to know how to fix it.
argument-hint: "<error_code> <file_path> [range]"
arguments: [error_code, file_path, range]
allowed-tools:
  - Read
  - mcp__plugin_spring-tools_spring-tools-mcp__getProjectList
  - mcp__plugin_spring-tools_spring-tools-mcp__getSpringBootVersion
---

You have encountered the Spring Boot diagnostic error code: `$ARGUMENTS[0]`.
The problem is located in the file: `$ARGUMENTS[1]`.
The text range of the problem is: `$ARGUMENTS[2]` (if provided).

MUST DO: If the error code includes a prefix like `errorCode=` or `code=`, strip it out before you continue to use it anywhere.

To find the official explanation and potential fixes for this issue, you must read the explanation file located at:
`${CLAUDE_PLUGIN_ROOT}/explanations/$ARGUMENTS[0].md`

If that explanation refers to another diagnostic code (for example "see `JAVA_LAMBDA_DSL`"), also read `${CLAUDE_PLUGIN_ROOT}/explanations/<THAT_CODE>.md` before deciding on a fix; such hints are usually meant to be applied together.

If the file does not exist, use the diagnostic message reported by the spring-tools MCP server (it often names the exact element, path, or version involved) together with your general Spring Boot knowledge to fix the issue.

Based on the provided "Explanations" and "Fixes" in that file:

1. Determine which Spring Boot, Spring Framework and Spring Security versions the project uses (use the `getSpringBootVersion` tool of the spring-tools MCP server, or read the build file). The explanations contain version-specific instructions - for example APIs that only exist from a certain version on, or that were removed later - and the fix must compile on the project's versions.
2. Analyze the context of the user's project and the specific file (`$ARGUMENTS[1]`) to determine which of the suggested fixes is the most appropriate.
3. If there are multiple potential fixes and it is unclear which one to apply based on the project context, stop and ask the user which solution they prefer.
4. Once a solution is chosen (either by your analysis or the user's choice), apply the fix to the codebase, specifically targeting the file `$ARGUMENTS[1]`.
5. If a text range (`$ARGUMENTS[2]`) is provided, ensure your fix is applied only around that specific text range.
6. The plugin's hooks notify the language server about the edited files automatically; to confirm that the diagnostic is gone, re-run the validation (`/spring-tools:validate`) after all fixes have been applied rather than after each single one.
