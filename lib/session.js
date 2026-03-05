const axios = require("axios");
const { CONFIG } = require("./config");

function createSession() {
  const cookieJar = {};
  const session = axios.create({
    baseURL: CONFIG.storeUrl,
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/json,*/*",
      "Accept-Language": "en-US,en;q=0.9",
    },
    validateStatus: (s) => s < 500,
  });

  session.interceptors.response.use((res) => {
    const setCookies = res.headers["set-cookie"];
    if (setCookies) {
      for (const raw of setCookies) {
        const [pair] = raw.split(";");
        const [name, ...rest] = pair.split("=");
        cookieJar[name.trim()] = rest.join("=").trim();
      }
    }
    return res;
  });

  session.interceptors.request.use((cfg) => {
    const cookieStr = Object.entries(cookieJar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (cookieStr) cfg.headers["Cookie"] = cookieStr;
    return cfg;
  });

  session._cookieJar = cookieJar;
  return session;
}

module.exports = { createSession };
