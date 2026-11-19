import { z } from 'zod';

export function settingsPath(id: string, page: 'agent' | 'assignment' = 'agent') {
  return '#settings/agents/' + id + (page === 'assignment' ? '/assignment' : '');
}

export async function post(path: string, data: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(await response.json());
    throw new Error(error.success ? error.data.error : 'Request failed');
  }
  return response;
}
