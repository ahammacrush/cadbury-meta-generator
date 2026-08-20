// Serverless function (Vercel Node runtime, no dependencies needed - uses the
// built-in fetch). Stores feedback notes as a JSON file committed to this
// repo via the GitHub Contents API, so every note is shared, versioned, and
// visible to anyone who opens the tool - no separate database required.
//
// Requires a GITHUB_TOKEN environment variable (a GitHub personal access
// token with `repo` write access to this repository) set in the Vercel
// project settings.

const OWNER = 'ahammacrush';
const REPO = 'cadbury-meta-generator';
const PATH = 'feedback-notes.json';
const BRANCH = 'main';
const MAX_NOTES = 500;
const MAX_NOTE_LENGTH = 2000;

function githubHeaders() {
    return {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'cadbury-meta-generator-notes'
    };
}

function contentsUrl() {
    return `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
}

async function readNotes() {
    const res = await fetch(`${contentsUrl()}?ref=${BRANCH}`, { headers: githubHeaders() });
    if (res.status === 404) return { notes: [], sha: undefined };
    if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
    const data = await res.json();
    const notes = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    return { notes, sha: data.sha };
}

async function appendNote(entry) {
    // A couple of retries in case two people save a note at the same moment
    // and race on the file's git sha.
    for (let attempt = 0; attempt < 3; attempt++) {
        const { notes, sha } = await readNotes();
        notes.push(entry);
        const trimmed = notes.length > MAX_NOTES ? notes.slice(notes.length - MAX_NOTES) : notes;

        const putRes = await fetch(contentsUrl(), {
            method: 'PUT',
            headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: `Add feedback note${entry.productName ? ' (' + entry.productName + ')' : ''}`,
                content: Buffer.from(JSON.stringify(trimmed, null, 2) + '\n', 'utf-8').toString('base64'),
                branch: BRANCH,
                ...(sha ? { sha } : {})
            })
        });

        if (putRes.ok) return;
        if (putRes.status !== 409 && putRes.status !== 422) {
            throw new Error(`GitHub write failed: ${putRes.status} ${await putRes.text()}`);
        }
        // 409/422 usually means the sha moved under us - loop and retry
    }
    throw new Error('Failed to save note after retries (conflicting writes).');
}

module.exports = async function handler(req, res) {
    if (!process.env.GITHUB_TOKEN) {
        res.status(500).json({ error: 'GITHUB_TOKEN is not configured on the server.' });
        return;
    }

    if (req.method === 'GET') {
        try {
            const { notes } = await readNotes();
            notes.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
            res.status(200).json(notes);
        } catch (e) {
            res.status(502).json({ error: 'Failed to load notes.' });
        }
        return;
    }

    if (req.method === 'POST') {
        try {
            const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
            const noteText = (body.note || '').toString().trim();
            if (!noteText) { res.status(400).json({ error: 'Note text is required.' }); return; }

            const entry = {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
                timestamp: new Date().toISOString(),
                productName: (body.productName || '').toString().slice(0, 300),
                generatedText: (body.generatedText || '').toString().slice(0, 400),
                note: noteText.slice(0, MAX_NOTE_LENGTH)
            };

            await appendNote(entry);
            res.status(200).json(entry);
        } catch (e) {
            res.status(502).json({ error: 'Failed to save note.' });
        }
        return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
};
