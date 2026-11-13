// One commit as the flows page shows it when a `commit` evidence entry is
// opened: subject, body, author, date, the files it touched and its patch.
// `git` is server.mjs's runner, `(args, cwd?) => Promise<{ ok, out, err }>`,
// with its output already trimmed. The caller checks `sha` is hex first.

/** Same cut and tail as /api/diff, so a huge commit cannot stall the page. */
const MAX = 400_000

/** `{ sha, subject, body, author, date, files: [{ status, path }], patch }`, or null when git show fails. */
export async function commitDiff(git, sha) {
  const [meta, names, patch] = await Promise.all([
    git(['show', '-s', '--format=%s%x00%b%x00%an%x00%cs', sha]),
    git(['show', '--name-status', '--format=', sha]),
    git(['show', '--format=', '--no-color', '--no-ext-diff', sha]),
  ])
  if (!meta.ok || !names.ok || !patch.ok) return null
  const [subject = '', body = '', author = '', date = ''] = meta.out.split('\0')
  return {
    sha,
    subject,
    body: body.trim(),
    author,
    date: date.trim(),
    files: parseNameStatus(names.out),
    patch: patch.out.length > MAX ? `${patch.out.slice(0, MAX)}\n… diff cut at 400 KB` : patch.out,
  }
}

/**
 * `M\tpath` lines into `{ status, path }`. A rename or copy (`R100\told\tnew`)
 * keeps its letter and shows the NEW path, the one the patch ends on.
 */
function parseNameStatus(out) {
  return out.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t')
    return { status: parts[0][0], path: parts.at(-1) }
  })
}
