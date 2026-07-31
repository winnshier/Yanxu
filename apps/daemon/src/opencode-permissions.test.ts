import { describe, expect, it } from 'vitest';
import { permissionPollingFailure, permissionRules } from '@yanxu/executors';
import { workspacePermissionPathPatterns } from './scheduler.js';

describe('OpenCode workspace permissions', () => {
  it('matches macOS absolute paths after OpenCode removes the leading slash', () => {
    expect(workspacePermissionPathPatterns(
      'dir_example',
      '/Users/example/.yanxu/runtime/tasks/task_example/workspace/dir_example',
    )).toEqual([
      'dir_example',
      'dir_example/**',
      '/Users/example/.yanxu/runtime/tasks/task_example/workspace/dir_example',
      '/Users/example/.yanxu/runtime/tasks/task_example/workspace/dir_example/**',
      'Users/example/.yanxu/runtime/tasks/task_example/workspace/dir_example',
      'Users/example/.yanxu/runtime/tasks/task_example/workspace/dir_example/**',
    ]);
  });

  it('allows workspace discovery expressions while keeping file reads path-scoped', () => {
    const rules = permissionRules('managed', true, {
      allowedReadPatterns: ['dir_example', 'dir_example/**'],
      allowedExternalDirectoryPatterns: [
        '/Users/example/.yanxu/projects/prj_example/artifacts/task_example/implementation-report/v1.md',
      ],
      allowedEditPatterns: [],
      allowedBashPatterns: ['pwd', 'ls', 'ls -la'],
      taskGrants: [],
      forbiddenReadPatterns: [],
      networkPolicy: 'deny',
      dependencyInstallPolicy: 'deny',
    });

    expect(rules).toContainEqual({ permission: 'read', pattern: 'dir_example/**', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'glob', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'grep', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'list', pattern: '*', action: 'allow' });
    expect(rules).not.toContainEqual({ permission: 'read', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({
      permission: 'external_directory',
      pattern: '/Users/example/.yanxu/projects/prj_example/artifacts/task_example/implementation-report/v1.md',
      action: 'allow',
    });
    expect(rules).not.toContainEqual({ permission: 'external_directory', pattern: '*', action: 'allow' });
    expect(rules).toContainEqual({ permission: 'edit', pattern: '*', action: 'deny' });
    expect(rules).toContainEqual({ permission: 'web*', pattern: '*', action: 'deny' });
  });

  it('turns a persistent permission protocol error into an observable failure', () => {
    const protocolError = new Error('Expected JSON value, got undefined at metadata.timeout');
    expect(permissionPollingFailure(protocolError, 9)).toBeNull();
    const failure = permissionPollingFailure(protocolError, 10);
    expect(failure?.name).toBe('OpenCodePermissionPollingError');
    expect(failure?.message).toContain('metadata.timeout');
  });
});
