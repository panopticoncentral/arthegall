/** Explicit launch restrictions apply before any provider thread is opened. */
export function launchArgs(profile: string): string[] {
  if (!/^arthegall_[a-f0-9-]+$/.test(profile)) throw new Error("Invalid generated permission profile");
  const args = ['app-server', '--stdio'];
  for (const feature of [
    'apps', 'plugins', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2',
    'browser_use', 'browser_use_external', 'computer_use', 'image_generation',
    'shell_snapshot', 'workspace_dependencies', 'skill_mcp_dependency_install',
  ]) args.push('-c', `features.${feature}=false`);
  args.push('-c', 'web_search="disabled"');
  args.push('-c', 'project_doc_max_bytes=0');
  args.push('-c', 'allow_login_shell=false');
  args.push('-c', `permissions.${profile}.filesystem={":minimal"="read",":workspace_roots"="read"}`);
  args.push('-c', `permissions.${profile}.network.enabled=false`);
  args.push('-c', 'shell_environment_policy.inherit="none"');
  return args;
}

/** Do not forward runner/server credentials or unrelated API keys to Codex. */
export function providerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

export function threadConfig(inheritedMcp: Record<string, unknown>, url: string, token: string) {
  // An empty map merges with user configuration; disable every inherited entry.
  const servers = Object.fromEntries(Object.keys(inheritedMcp).map((name) => [name, { enabled: false }]));
  servers.arthegall = { enabled: true };
  return {
    mcp_servers: { ...servers, arthegall: {
      enabled: true, url, http_headers: { Authorization: `Bearer ${token}` },
      enabled_tools: ['read_context', 'report_outcome'],
    } },
    'features.shell_tool': false,
    'features.view_image': false,
    'features.skip_host_skill_discovery': true,
  };
}
