import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const APP_URL = 'https://nurdu-coaching.pages.dev';
const cors = {
  'Access-Control-Allow-Origin': APP_URL,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};
const respond = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return respond({ error: 'Method not allowed' }, 405);
  try {
    const url = Deno.env.get('SUPABASE_URL');
    const anon = Deno.env.get('SUPABASE_ANON_KEY');
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anon || !service) return respond({ error: 'Serverkonfiguration fehlt' }, 500);
    const bearer = req.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!bearer) return respond({ error: 'Nicht angemeldet' }, 401);
    const auth = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: identity, error: authError } = await auth.auth.getUser(bearer);
    if (authError || !identity.user) return respond({ error: 'Ungültige Anmeldung' }, 401);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: coach, error: coachError } = await admin.from('profiles')
      .select('id,role').eq('id', identity.user.id).single();
    if (coachError || coach?.role !== 'coach') return respond({ error: 'Nur Coaches dürfen Links erstellen' }, 403);
    let payload: { email?: string };
    try { payload = await req.json(); } catch { return respond({ error: 'Ungültige Anfrage' }, 400); }
    const email = String(payload.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      return respond({ error: 'Ungültige E-Mail-Adresse' }, 400);
    // Auth-E-Mail anhand der User-ID prüfen, ohne eine profiles.email-Spalte vorauszusetzen.
    const { data: clients, error: clientError } = await admin.from('profiles')
      .select('id').eq('coach_id', identity.user.id).eq('role', 'client');
    if (clientError) return respond({ error: 'Klientenprofile konnten nicht geprüft werden' }, 500);
    let matched = false;
    for (const client of clients || []) {
      const { data: userResult, error: userError } = await admin.auth.admin.getUserById(client.id);
      if (userError) continue;
      if (userResult.user?.email?.toLowerCase() === email) { matched = true; break; }
    }
    if (!matched) return respond({ error: 'Kein Klient mit dieser E-Mail diesem Coach zugeordnet. Bitte zuerst Klient anlegen.' }, 404);
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'recovery', email, options: { redirectTo: APP_URL },
    });
    if (error || !data?.properties?.action_link)
      return respond({ error: 'Supabase konnte keinen Passwortlink erstellen: ' + (error?.message || 'Unbekannter Fehler') }, 500);
    return respond({ link: data.properties.action_link });
  } catch (_e) {
    return respond({ error: 'Interner Serverfehler' }, 500);
  }
});
