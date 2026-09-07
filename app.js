require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI, SESSION_SECRET } = process.env;
const scopes = ['user-read-private', 'user-read-email', 'user-top-read', 'user-read-recently-played'];

app.set('view engine', 'ejs');
app.set('views', `${__dirname}/views`);
app.use(express.static(`${__dirname}/public`));
app.use(session({
  secret: SESSION_SECRET || 'change-this-in-your-env-file',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

function configured() {
  return Boolean(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET && SPOTIFY_REDIRECT_URI && SESSION_SECRET);
}

function basicAuth() {
  return `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`;
}

async function requestToken(params) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'Spotify could not issue a token.');
  return data;
}

async function spotifyFetch(req, endpoint) {
  let { accessToken, refreshToken, expiresAt } = req.session;
  if (!accessToken) throw new Error('Please sign in with Spotify first.');

  if (Date.now() >= expiresAt - 30_000) {
    const token = await requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
    accessToken = token.access_token;
    req.session.accessToken = accessToken;
    req.session.expiresAt = Date.now() + token.expires_in * 1000;
    req.session.refreshToken = token.refresh_token || refreshToken;
  }

  const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (response.status === 401) {
    req.session.destroy(() => {});
    throw new Error('Your Spotify session expired. Please sign in again.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Spotify request failed.');
  return data;
}

app.get('/', (req, res) => res.render('index', { configured: configured(), loggedIn: Boolean(req.session.accessToken) }));

app.get('/login', (req, res) => {
  if (!configured()) return res.status(500).render('error', { message: 'Add your Spotify app credentials to .env before signing in.' });
  const state = crypto.randomBytes(24).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    response_type: 'code', client_id: SPOTIFY_CLIENT_ID, redirect_uri: SPOTIFY_REDIRECT_URI,
    state, scope: scopes.join(' ')
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/callback', async (req, res, next) => {
  try {
    if (req.query.error) 
      throw new Error(`Spotify authorization was cancelled: ${req.query.error}`);
    if (!req.query.code || req.query.state !== req.session.oauthState) 
      throw new Error('Invalid sign-in state. Try again.');
    const token = await requestToken({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: SPOTIFY_REDIRECT_URI });
    req.session.accessToken = token.access_token;
    req.session.refreshToken = token.refresh_token;
    req.session.expiresAt = Date.now() + token.expires_in * 1000;
    delete req.session.oauthState;
    res.redirect('/dashboard');
  } catch (error) { next(error); }
});

app.get('/dashboard', async (req, res, next) => {
  try {
    if (!req.session.accessToken) return res.redirect('/');
    const [profile, artists, tracks, recent] = await Promise.all([
      spotifyFetch(req, '/me'),
      spotifyFetch(req, '/me/top/artists?limit=6&time_range=short_term'),
      spotifyFetch(req, '/me/top/tracks?limit=8&time_range=short_term'),
      spotifyFetch(req, '/me/player/recently-played?limit=8')
    ]);
    res.render('dashboard', { profile, artists: artists.items, tracks: tracks.items, recent: recent.items });
  } catch (error) { next(error); }
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).render('error', { message: error.message || 'Something went wrong.' });
});

app.listen(PORT, () => console.log(`Listening dashboard running at http://127.0.0.1:${PORT}`));
