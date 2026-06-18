export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Magic-Word',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Route API requests
    if (path.startsWith('/api/')) {
      try {
        const response = await handleAPI(request, env, url, path);
        // Add CORS headers to every response
        const headers = new Headers(response.headers);
        for (const [k, v] of Object.entries(corsHeaders)) {
          headers.set(k, v);
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (err) {
        return jsonResponse({ error: err.message || 'Internal server error' }, 500, corsHeaders);
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};

// --- Auth helper ---
function checkMagicWord(request, env) {
  const word = request.headers.get('X-Magic-Word');
  if (word !== env.MAGIC_WORD) {
    return jsonResponse({ error: 'Wrong magic word' }, 401);
  }
  return null; // auth passed
}

// --- JSON helper ---
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// --- Slug helper ---
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
}

// --- Random string ---
function rand4() {
  return Math.random().toString(36).substring(2, 6);
}

// --- Router ---
async function handleAPI(request, env, url, path) {
  const method = request.method;

  // --- Photo endpoints ---

  // Upload photos
  if (method === 'POST' && path === '/api/photos/upload') {
    const authErr = checkMagicWord(request, env);
    if (authErr) return authErr;

    const formData = await request.formData();
    const uploaderName = formData.get('uploader_name');
    const year = formData.get('year') || '';

    if (!uploaderName) {
      return jsonResponse({ error: 'uploader_name is required' }, 400);
    }

    const slug = slugify(uploaderName);
    const files = formData.getAll('photo');
    const uploaded = [];

    for (const file of files) {
      if (!(file instanceof File)) continue;

      const ext = file.name.split('.').pop().toLowerCase();
      const allowed = ['jpg', 'jpeg', 'png', 'gif', 'heic', 'webp'];
      if (!allowed.includes(ext)) continue;

      const key = `${slug}/${Date.now()}-${rand4()}.jpg`;
      const arrayBuffer = await file.arrayBuffer();

      await env.PHOTOS.put(key, arrayBuffer, {
        httpMetadata: { contentType: 'image/jpeg' },
        customMetadata: {
          uploader_name: uploaderName,
          original_filename: file.name,
          year: year,
          uploaded_at: new Date().toISOString(),
        },
      });

      uploaded.push({ key, uploader_name: uploaderName, year });
    }

    return jsonResponse({ success: true, uploaded });
  }

  // List photos
  if (method === 'GET' && path === '/api/photos') {
    const list = await env.PHOTOS.list({ limit: 1000 });
    const photos = [];

    for (const obj of list.objects) {
      // Skip guestbook and tree photos
      if (obj.key.startsWith('guestbook/') || obj.key.startsWith('tree/')) continue;

      const meta = obj.customMetadata || {};
      photos.push({
        key: obj.key,
        url: `/api/photos/view/${obj.key}`,
        uploader_name: meta.uploader_name || 'Unknown',
        year: meta.year || '',
        uploaded_at: meta.uploaded_at || obj.uploaded || '',
      });
    }

    // Sort
    const sort = url.searchParams.get('sort');
    const yearFilter = url.searchParams.get('year');

    if (yearFilter) {
      const filtered = photos.filter(p => p.year === yearFilter);
      return jsonResponse(filtered);
    }

    if (sort === 'person') {
      photos.sort((a, b) => a.uploader_name.localeCompare(b.uploader_name));
    } else {
      photos.sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''));
    }

    return jsonResponse(photos);
  }

  // View a photo
  if (method === 'GET' && path.startsWith('/api/photos/view/')) {
    const key = path.replace('/api/photos/view/', '');
    const object = await env.PHOTOS.get(key);
    if (!object) return new Response('Not found', { status: 404 });

    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
    headers.set('Cache-Control', 'public, max-age=31536000');
    return new Response(object.body, { headers });
  }

  // Download a photo
  if (method === 'GET' && path.startsWith('/api/photos/download/')) {
    const key = path.replace('/api/photos/download/', '');
    const object = await env.PHOTOS.get(key);
    if (!object) return new Response('Not found', { status: 404 });

    const originalFilename = object.customMetadata?.original_filename || key.split('/').pop();
    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
    headers.set('Content-Disposition', `attachment; filename="${originalFilename}"`);
    return new Response(object.body, { headers });
  }

  // List uploaders
  if (method === 'GET' && path === '/api/photos/uploaders') {
    const list = await env.PHOTOS.list({ limit: 1000 });
    const uploaders = {};

    for (const obj of list.objects) {
      if (obj.key.startsWith('guestbook/') || obj.key.startsWith('tree/')) continue;
      const name = obj.customMetadata?.uploader_name || 'Unknown';
      if (!uploaders[name]) {
        uploaders[name] = { name, slug: slugify(name), count: 0 };
      }
      uploaders[name].count++;
    }

    return jsonResponse(Object.values(uploaders));
  }

  // --- Guestbook endpoints ---

  if (method === 'POST' && path === '/api/guestbook') {
    const authErr = checkMagicWord(request, env);
    if (authErr) return authErr;

    const formData = await request.formData();
    const name = formData.get('name');
    const message = formData.get('message');
    const signatureData = formData.get('signature_data') || null;
    const photo = formData.get('photo');

    if (!name || !message) {
      return jsonResponse({ error: 'name and message are required' }, 400);
    }

    let photoKey = null;
    if (photo && photo instanceof File && photo.size > 0) {
      photoKey = `guestbook/${Date.now()}-${rand4()}.jpg`;
      const arrayBuffer = await photo.arrayBuffer();
      await env.PHOTOS.put(photoKey, arrayBuffer, {
        httpMetadata: { contentType: 'image/jpeg' },
        customMetadata: { uploader_name: name, uploaded_at: new Date().toISOString() },
      });
    }

    const result = await env.DB.prepare(
      'INSERT INTO guestbook (name, message, signature_data, photo_key) VALUES (?, ?, ?, ?)'
    ).bind(name, message, signatureData, photoKey).run();

    return jsonResponse({
      success: true,
      entry: { id: result.meta.last_row_id, name, message, created_at: new Date().toISOString() },
    });
  }

  if (method === 'GET' && path === '/api/guestbook') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM guestbook ORDER BY created_at DESC'
    ).all();

    const entries = results.map(r => ({
      ...r,
      photo_url: r.photo_key ? `/api/photos/view/${r.photo_key}` : null,
    }));

    return jsonResponse(entries);
  }

  // --- Fun facts endpoints ---

  if (method === 'POST' && path === '/api/funfacts') {
    const authErr = checkMagicWord(request, env);
    if (authErr) return authErr;

    const body = await request.json();
    if (!body.name || !body.fact) {
      return jsonResponse({ error: 'name and fact are required' }, 400);
    }

    await env.DB.prepare(
      'INSERT INTO fun_facts (name, fact) VALUES (?, ?)'
    ).bind(body.name, body.fact).run();

    return jsonResponse({ success: true });
  }

  if (method === 'GET' && path === '/api/funfacts') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM fun_facts ORDER BY created_at DESC'
    ).all();
    return jsonResponse(results);
  }

  // --- Family tree endpoints ---

  if (method === 'POST' && path === '/api/tree') {
    const authErr = checkMagicWord(request, env);
    if (authErr) return authErr;

    const formData = await request.formData();
    const name = formData.get('name');
    const relationship = formData.get('relationship');
    const relationshipCategory = formData.get('relationship_category');
    const note = formData.get('note') || null;
    const photo = formData.get('photo');

    if (!name || !relationship || !relationshipCategory) {
      return jsonResponse({ error: 'name, relationship, and relationship_category are required' }, 400);
    }

    let photoKey = null;
    if (photo && photo instanceof File && photo.size > 0) {
      photoKey = `tree/${Date.now()}-${rand4()}.jpg`;
      const arrayBuffer = await photo.arrayBuffer();
      await env.PHOTOS.put(photoKey, arrayBuffer, {
        httpMetadata: { contentType: 'image/jpeg' },
        customMetadata: { uploader_name: name, uploaded_at: new Date().toISOString() },
      });
    }

    const result = await env.DB.prepare(
      'INSERT INTO family_tree (name, relationship, relationship_category, note, photo_key) VALUES (?, ?, ?, ?, ?)'
    ).bind(name, relationship, relationshipCategory, note, photoKey).run();

    return jsonResponse({
      success: true,
      node: { id: result.meta.last_row_id, name, relationship, relationship_category: relationshipCategory },
    });
  }

  if (method === 'GET' && path === '/api/tree') {
    const { results } = await env.DB.prepare(
      'SELECT * FROM family_tree ORDER BY created_at DESC'
    ).all();

    const grouped = { family: [], friends: [], other: [] };
    for (const node of results) {
      const cat = node.relationship_category.toLowerCase();
      const entry = {
        ...node,
        photo_url: node.photo_key ? `/api/photos/view/${node.photo_key}` : null,
      };
      if (cat === 'family') grouped.family.push(entry);
      else if (cat === 'friend') grouped.friends.push(entry);
      else grouped.other.push(entry);
    }

    return jsonResponse(grouped);
  }

  // --- Phase 2: Admin delete stubs ---

  // DELETE /api/photos/:key — Phase 2: Admin panel
  if (method === 'DELETE' && path.startsWith('/api/photos/')) {
    return jsonResponse({ error: 'Not implemented — Phase 2 admin feature' }, 501);
  }

  // DELETE /api/guestbook/:id — Phase 2: Admin panel
  if (method === 'DELETE' && path.startsWith('/api/guestbook/')) {
    return jsonResponse({ error: 'Not implemented — Phase 2 admin feature' }, 501);
  }

  // DELETE /api/funfacts/:id — Phase 2: Admin panel
  if (method === 'DELETE' && path.startsWith('/api/funfacts/')) {
    return jsonResponse({ error: 'Not implemented — Phase 2 admin feature' }, 501);
  }

  // DELETE /api/tree/:id — Phase 2: Admin panel
  if (method === 'DELETE' && path.startsWith('/api/tree/')) {
    return jsonResponse({ error: 'Not implemented — Phase 2 admin feature' }, 501);
  }

  return jsonResponse({ error: 'Not found' }, 404);
}
