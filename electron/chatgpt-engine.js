// fluxnotes — ChatGPT Engine.
// Performs SSE message streaming, multi-session state isolation, and handles proof-of-work challenges.

(function () {
  if (window.__fluxnotesChatGPT) return;

  var TIMEOUT = 360000;

  var _conversationId = null;
  var _parentMessageId = null;
  var _cachedToken = null;
  var _tokenExpiry = 0;

  var _currentSessionId = null;
  var _sessions = {};

  var MAX_SESSIONS = 200;
  function _pruneSessions() {
    var keys = Object.keys(_sessions);
    for (
      var i = 0;
      i < keys.length && Object.keys(_sessions).length > MAX_SESSIONS;
      i++
    ) {
      if (keys[i] !== _currentSessionId) delete _sessions[keys[i]];
    }
  }

  function activateSession(sessionId) {
    if (!sessionId) sessionId = "default";
    _currentSessionId = sessionId;
    if (!_sessions[sessionId]) {
      _sessions[sessionId] = { conversationId: null, parentMessageId: null };
    }
    var sess = _sessions[sessionId];
    _conversationId = sess.conversationId;
    _parentMessageId = sess.parentMessageId;
    return sess;
  }

  function saveSession(sessionId) {
    if (!sessionId) sessionId = "default";
    var sess = _sessions[sessionId];
    if (sess) {
      sess.conversationId = _conversationId;
      sess.parentMessageId = _parentMessageId;
    }
    _pruneSessions();
  }

  var SHA3 = (function () {
    var RC = [
      [0x00000001, 0x00000000],
      [0x00008082, 0x00000000],
      [0x0000808a, 0x80000000],
      [0x80008000, 0x80000000],
      [0x0000808b, 0x00000000],
      [0x80000001, 0x00000000],
      [0x80008081, 0x80000000],
      [0x00008009, 0x80000000],
      [0x0000008a, 0x00000000],
      [0x00000088, 0x00000000],
      [0x80008009, 0x00000000],
      [0x8000000a, 0x00000000],
      [0x8000808b, 0x00000000],
      [0x0000008b, 0x80000000],
      [0x00008089, 0x80000000],
      [0x00008003, 0x80000000],
      [0x00008002, 0x80000000],
      [0x00000080, 0x80000000],
      [0x0000800a, 0x00000000],
      [0x8000000a, 0x80000000],
      [0x80008081, 0x80000000],
      [0x00008080, 0x80000000],
      [0x80000001, 0x00000000],
      [0x80008008, 0x80000000],
    ];
    var ROTL = [
      [0, 0],
      [1, 0],
      [62, 0],
      [28, 0],
      [27, 0],
      [36, 0],
      [44, 0],
      [6, 0],
      [55, 0],
      [20, 0],
      [3, 0],
      [10, 0],
      [43, 0],
      [25, 0],
      [39, 0],
      [41, 0],
      [45, 0],
      [15, 0],
      [21, 0],
      [8, 0],
      [18, 0],
      [2, 0],
      [61, 0],
      [56, 0],
      [14, 0],
    ];
    var PI = [
      0, 10, 20, 5, 15, 16, 1, 11, 21, 6, 7, 17, 2, 12, 22, 23, 8, 18, 3, 13,
      14, 24, 9, 19, 4,
    ];

    function rot64(lo, hi, n) {
      if (n === 0) return [lo, hi];
      if (n < 32)
        return [(lo << n) | (hi >>> (32 - n)), (hi << n) | (lo >>> (32 - n))];
      n -= 32;
      return [(hi << n) | (lo >>> (32 - n)), (lo << n) | (hi >>> (32 - n))];
    }

    function keccakf(state) {
      var s = new Int32Array(50);
      for (var i = 0; i < 50; i++) s[i] = state[i];
      for (var round = 0; round < 24; round++) {
        var C = new Int32Array(10);
        for (var x = 0; x < 5; x++) {
          C[x * 2] =
            s[x * 2] ^
            s[(x + 5) * 2] ^
            s[(x + 10) * 2] ^
            s[(x + 15) * 2] ^
            s[(x + 20) * 2];
          C[x * 2 + 1] =
            s[x * 2 + 1] ^
            s[(x + 5) * 2 + 1] ^
            s[(x + 10) * 2 + 1] ^
            s[(x + 15) * 2 + 1] ^
            s[(x + 20) * 2 + 1];
        }
        for (var x = 0; x < 5; x++) {
          var px = (x + 4) % 5,
            nx = (x + 1) % 5;
          var d = rot64(C[nx * 2], C[nx * 2 + 1], 1);
          var tlo = C[px * 2] ^ d[0],
            thi = C[px * 2 + 1] ^ d[1];
          for (var y = 0; y < 25; y += 5) {
            s[(y + x) * 2] ^= tlo;
            s[(y + x) * 2 + 1] ^= thi;
          }
        }
        var B = new Int32Array(50);
        for (var i = 0; i < 25; i++) {
          var r = rot64(s[i * 2], s[i * 2 + 1], ROTL[i][0] % 64);
          B[PI[i] * 2] = r[0];
          B[PI[i] * 2 + 1] = r[1];
        }
        for (var y = 0; y < 25; y += 5) {
          for (var x = 0; x < 5; x++) {
            s[(y + x) * 2] =
              B[(y + x) * 2] ^
              (~B[(y + ((x + 1) % 5)) * 2] & B[(y + ((x + 2) % 5)) * 2]);
            s[(y + x) * 2 + 1] =
              B[(y + x) * 2 + 1] ^
              (~B[(y + ((x + 1) % 5)) * 2 + 1] &
                B[(y + ((x + 2) % 5)) * 2 + 1]);
          }
        }
        s[0] ^= RC[round][0];
        s[1] ^= RC[round][1];
      }
      for (var i = 0; i < 50; i++) state[i] = s[i];
    }

    function sha3_512(message) {
      var rate = 72;
      var msgBytes = new TextEncoder().encode(message);
      var padLen = rate - (msgBytes.length % rate);
      var padded = new Uint8Array(msgBytes.length + padLen);
      padded.set(msgBytes);
      padded[msgBytes.length] = 0x06;
      padded[padded.length - 1] |= 0x80;
      var state = new Int32Array(50);
      for (var offset = 0; offset < padded.length; offset += rate) {
        for (var i = 0; i < rate; i += 4) {
          var idx = i / 4;
          if (idx < 50) {
            state[idx] ^=
              padded[offset + i] |
              (padded[offset + i + 1] << 8) |
              (padded[offset + i + 2] << 16) |
              (padded[offset + i + 3] << 24);
          }
        }
        keccakf(state);
      }
      var hash = new Uint8Array(64);
      for (var i = 0; i < 64; i += 4) {
        var w = state[i / 4];
        hash[i] = w & 0xff;
        hash[i + 1] = (w >> 8) & 0xff;
        hash[i + 2] = (w >> 16) & 0xff;
        hash[i + 3] = (w >> 24) & 0xff;
      }
      return Array.from(hash)
        .map(function (b) {
          return b.toString(16).padStart(2, "0");
        })
        .join("");
    }

    return { sha3_512: sha3_512 };
  })();

  async function _solvePOW(seed, difficulty, scripts, dpl) {
    function encode(arr) {
      var json = JSON.stringify(arr);
      return btoa(
        String.fromCharCode.apply(null, new TextEncoder().encode(json)),
      );
    }
    var startTime = performance.now();
    var navKeys = Object.keys(Object.getPrototypeOf(navigator));
    var pickRandom = function (arr) {
      return arr[Math.floor(Math.random() * arr.length)];
    };

    var config = [
      navigator.hardwareConcurrency + screen.width + screen.height,
      new Date().toString(),
      (performance.memory && performance.memory.jsHeapSizeLimit) || 4294705152,
      0,
      navigator.userAgent,
      pickRandom(scripts || [null]),
      dpl || "",
      navigator.language,
      navigator.languages.join(","),
      0,
      pickRandom(navKeys) + "-" + navigator[pickRandom(navKeys)],
      pickRandom(Object.keys(document)),
      pickRandom(Object.keys(window)),
      performance.now(),
      crypto.randomUUID(),
    ];

    for (var i = 1; i < 100000; i++) {
      // Yield to the event loop periodically to keep the UI responsive.
      if (i % 2000 === 0)
        await new Promise(function (r) {
          setTimeout(r, 10);
        });
      config[3] = i;
      config[9] = Math.round(performance.now() - startTime);
      var encoded = encode(config);
      var hash = SHA3.sha3_512(seed + encoded);
      if (hash.substring(0, difficulty.length) <= difficulty) {
        return encoded;
      }
    }
    return null;
  }

  async function _getToken() {
    if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
    var res = await fetch("/api/auth/session", { credentials: "include" });
    if (res.status === 429) throw new Error("Too many requests");
    if (res.status === 403) throw new Error("Cloudflare check required");
    if (!res.ok) throw new Error("Session failed (" + res.status + ")");
    var data = await res.json();
    if (!data.accessToken) throw new Error("Not logged in to ChatGPT");
    _cachedToken = data.accessToken;
    _tokenExpiry = Date.now() + 300000;
    return _cachedToken;
  }

  var _cachedScripts = null;
  var _cachedDpl = null;

  async function _getScriptsAndDpl() {
    if (_cachedScripts) return { scripts: _cachedScripts, dpl: _cachedDpl };
    try {
      var html = await fetch("/", { credentials: "include" }).then(
        function (r) {
          return r.text();
        },
      );
      _cachedScripts = [];
      var m;
      var re = /src="([^"]*)"/g;
      while ((m = re.exec(html)) !== null) _cachedScripts.push(m[1]);
      var dplMatch = html.match(/dpl=([a-zA-Z0-9_-]+)/);
      _cachedDpl = dplMatch ? dplMatch[1] : "";
    } catch (e) {
      _cachedScripts = [null];
      _cachedDpl = "";
    }
    return { scripts: _cachedScripts, dpl: _cachedDpl };
  }

  async function _getRequirementsAndPOW(token) {
    var reqRes = await fetch("/backend-api/sentinel/chat-requirements", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify({ conversation_mode_kind: "primary_assistant" }),
    });

    if (!reqRes.ok) return {};
    var req = await reqRes.json();
    var result = { requirementsToken: req.token || null };

    if (req.proofofwork && req.proofofwork.required) {
      var sd = await _getScriptsAndDpl();
      var powToken = await _solvePOW(
        req.proofofwork.seed,
        req.proofofwork.difficulty,
        sd.scripts,
        sd.dpl,
      );
      if (powToken) result.proofToken = "gAAAAAB" + powToken;
    }

    return result;
  }

  function _extractImageInfoFromText(text) {
    var results = [];
    if (!text) return results;
    try {
      var jsonBlocks = text.match(/```json\s*([\s\S]*?)```/g) || [];
      var candidates = jsonBlocks.map(function (b) {
        return b.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      });
      candidates.push(text);
      for (var i = 0; i < candidates.length; i++) {
        try {
          var obj = JSON.parse(candidates[i]);
          if (obj && typeof obj === "object") {
            var found = [];
            if (obj.status === "IMAGE_GENERATED") found.push(obj);
            if (Array.isArray(obj.images)) {
              for (var k = 0; k < obj.images.length; k++) {
                if (obj.images[k] && (obj.images[k].imagePath || obj.images[k].fileId)) found.push(obj.images[k]);
              }
            }
            for (var j = 0; j < found.length; j++) {
              var info = found[j];
              results.push({
                imagePath: info.imagePath || null,
                fileId: info.fileId || null,
                generationId: info.generationId || null,
              });
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
    return results;
  }

  async function _parseSSEStream(response) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var fullText = "";
    var messageId = null;
    var generationId = null;
    var fileId = null;
    var sandboxImagePaths = [];
    var buffer = "";

    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.startsWith("data: ")) continue;
          var data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            var parsed = JSON.parse(data);

            if (parsed.conversation_id) {
              _conversationId = parsed.conversation_id;
            }

            if (!generationId && parsed.message && parsed.message.generation_id) {
              generationId = parsed.message.generation_id;
            }

            var parts =
              parsed &&
              parsed.message &&
              parsed.message.content &&
              parsed.message.content.parts;
            if (
              parts &&
              parts.length > 0 &&
              parsed.message.author &&
              parsed.message.author.role === "assistant"
            ) {
              fullText = parts.join("");

              if (typeof window.__fluxnotesOnContent === "function") {
                window.__fluxnotesOnContent(fullText);
              }

              if (parsed.message.id) {
                _parentMessageId = parsed.message.id;
                messageId = parsed.message.id;
              }

              if (!fileId && parsed.message.metadata && parsed.message.metadata.attachments) {
                try {
                  for (var ai = 0; ai < parsed.message.metadata.attachments.length; ai++) {
                    var att = parsed.message.metadata.attachments[ai];
                    if (att && att.id) {
                      fileId = att.id;
                      break;
                    }
                  }
                } catch (e) {}
              }

              try {
                for (var pi = 0; pi < parts.length; pi++) {
                  var part = parts[pi];
                  if (typeof part === "string") {
                    var sbm = part.match(/sandbox:\/mnt\/data\/[^\s"'<>\\)]+/g);
                    if (sbm) {
                      for (var si = 0; si < sbm.length; si++) {
                        if (sandboxImagePaths.indexOf(sbm[si]) === -1) sandboxImagePaths.push(sbm[si]);
                      }
                    }
                  }
                }
              } catch (e) {}
            }
          } catch (e) {}
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (e) {}
    }

    var parsedImages = _extractImageInfoFromText(fullText);
    var mergedImages = [];
    var seen = {};
    var addInfo = function (info) {
      if (!info || (!info.imagePath && !info.fileId && !info.generationId)) return;
      var key = (info.imagePath || "").trim();
      if (!key) {
        key = (info.fileId || "") + "|" + (info.generationId || "");
      }
      if (!seen[key]) {
        seen[key] = {};
        mergedImages.push(seen[key]);
      }
      var current = seen[key];
      for (var field in info) {
        if (Object.prototype.hasOwnProperty.call(info, field)) {
          if (info[field] != null && info[field] !== "" && (current[field] == null || current[field] === "") ) {
            current[field] = info[field];
          }
        }
      }
    };
    for (var ii = 0; ii < parsedImages.length; ii++) addInfo(parsedImages[ii]);
    for (var si2 = 0; si2 < sandboxImagePaths.length; si2++) {
      addInfo({ imagePath: sandboxImagePaths[si2], fileId: fileId, generationId: generationId });
    }
    if (mergedImages.length === 0 && (fileId || generationId)) {
      addInfo({ fileId: fileId, generationId: generationId });
    }

    return {
      text: fullText,
      messageId: messageId,
      generationId: generationId,
      fileId: fileId,
      generatedImages: mergedImages,
    };
  }

  async function uploadFileToChatGPT(fileBase64, filename, mimeType) {
    var token = await _getToken();

    var deviceId = "";
    try {
      var cookies = document.cookie.split(";");
      for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        if (c.startsWith("oai-did=")) {
          deviceId = c.substring(8);
          break;
        }
      }
    } catch (e) {}

    var binStr = atob(fileBase64);
    var size = binStr.length;
    var bytes = new Uint8Array(size);
    for (var i = 0; i < size; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }

    var headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      "OAI-Language": "en-US",
    };
    if (deviceId) headers["OAI-Device-Id"] = deviceId;

    var initPayload = {
      file_name: filename,
      file_size: size,
      use_case: "multimodal",
    };

    var initRes = await fetch("/backend-api/files", {
      method: "POST",
      credentials: "include",
      headers: headers,
      body: JSON.stringify(initPayload),
    });

    if (!initRes.ok) {
      var errText = await initRes.text();
      throw new Error(
        "ChatGPT file upload initialization failed (" +
          initRes.status +
          "): " +
          errText,
      );
    }

    var initData = await initRes.json();
    if (
      initData.status !== "success" ||
      !initData.upload_url ||
      !initData.file_id
    ) {
      throw new Error("Invalid response from files API");
    }

    var uploadUrl = initData.upload_url;
    var fileId = initData.file_id;

    console.log(
      "[fluxnotes ChatGPT API] Upload metadata created. Transferring binary bytes to Azure Blob...",
    );

    var uploadHeaders = {
      "Content-Type": mimeType,
      "x-ms-blob-type": "BlockBlob",
    };

    var finalRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: uploadHeaders,
      body: bytes,
    });

    if (!finalRes.ok) {
      var errText = await finalRes.text();
      throw new Error(
        "Azure Blob upload failed (" + finalRes.status + "): " + errText,
      );
    }

    console.log(
      "[fluxnotes ChatGPT API] Azure Blob transfer complete. Finalizing upload on ChatGPT backend...",
    );

    var finalizeRes = await fetch(
      "/backend-api/files/" + fileId + "/uploaded",
      {
        method: "POST",
        credentials: "include",
        headers: headers,
      },
    );

    if (!finalizeRes.ok) {
      var errText = await finalizeRes.text();
      throw new Error(
        "ChatGPT file upload finalization failed (" +
          finalizeRes.status +
          "): " +
          errText,
      );
    }

    console.log("[fluxnotes ChatGPT API] Upload finalized! File ID:", fileId);
    return fileId;
  }

  async function send(message, engine, attachments, sessionId) {
    activateSession(sessionId);

    var token = await _getToken();

    var deviceId = "";
    try {
      var cookies = document.cookie.split(";");
      for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        if (c.startsWith("oai-did=")) {
          deviceId = c.substring(8);
          break;
        }
      }
    } catch (e) {}

    var powData = await _getRequirementsAndPOW(token);

    var headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      Accept: "text/event-stream",
      "OAI-Language": "en-US",
    };

    if (deviceId) headers["OAI-Device-Id"] = deviceId;
    if (powData.requirementsToken)
      headers["Openai-Sentinel-Chat-Requirements-Token"] =
        powData.requirementsToken;
    if (powData.proofToken)
      headers["Openai-Sentinel-Proof-Token"] = powData.proofToken;

    var messageContent;
    var messageMetadata = {};

    var attachmentList = Array.isArray(attachments)
      ? attachments
      : attachments
        ? [attachments]
        : [];

    if (attachmentList.length > 0) {
      var attachmentParts = [message];
      for (var attachmentIndex = 0; attachmentIndex < attachmentList.length; attachmentIndex++) {
        var attachment = attachmentList[attachmentIndex];
        if (!attachment || !attachment.imageToken) continue;
        var fileId = attachment.imageToken;
        var mimeType = attachment.mimeType || "application/octet-stream";
        var fileSize = attachment.fileSize || 0;
        var isImage = mimeType.startsWith("image/");
        attachmentParts.push(isImage
          ? {
              content_type: "image_asset_pointer",
              asset_pointer: "file-service://" + fileId,
              size_bytes: fileSize,
              width: 500,
              height: 500,
            }
          : {
              content_type: "file_asset_pointer",
              asset_pointer: "file-service://" + fileId,
              size_bytes: fileSize,
            });
      }
      messageContent = {
        content_type: "multimodal_text",
        parts: attachmentParts,
      };
      messageMetadata = {};
    } else {
      messageContent = {
        content_type: "text",
        parts: [message],
      };
    }

    var payload = {
      action: "next",
      messages: [
        {
          id: crypto.randomUUID(),
          author: { role: "user" },
          content: messageContent,
          metadata: messageMetadata,
        },
      ],
      model: "auto",
      parent_message_id: _parentMessageId || crypto.randomUUID(),
      timezone_offset_min: new Date().getTimezoneOffset(),
      history_and_training_disabled: false,
      conversation_mode: { kind: "primary_assistant" },
      force_paragen: false,
      force_nulligen: false,
      force_rate_limit: false,
      websocket_request_id: crypto.randomUUID(),
    };

    if (_conversationId) {
      payload.conversation_id = _conversationId;
      console.log(
        "[FluxNotes ChatGPT] Continuing conversation:",
        _conversationId,
      );
    } else {
      console.log("[FluxNotes ChatGPT] Starting new conversation");
    }

    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, TIMEOUT);

    var res = await fetch("/backend-api/conversation", {
      method: "POST",
      credentials: "include",
      headers: headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // Refresh expired session token and retry the conversation request once.
    if (res.status === 401) {
      clearTimeout(timeoutId);
      var newToken = await _getToken();
      headers["Authorization"] = "Bearer " + newToken;
      var retryController = new AbortController();
      var retryTimeoutId = setTimeout(function () {
        retryController.abort();
      }, TIMEOUT);
      res = await fetch("/backend-api/conversation", {
        method: "POST",
        credentials: "include",
        headers: headers,
        body: JSON.stringify(payload),
        signal: retryController.signal,
      });
      if (!res.ok) {
        clearTimeout(retryTimeoutId);
        var err = await res.text().catch(function () {
          return "";
        });
        throw new Error(
          "ChatGPT API error (" + res.status + "): " + err.substring(0, 300),
        );
      }
      var retryContentType = res.headers.get("content-type") || "";
      if (retryContentType.startsWith("application/json")) {
        clearTimeout(retryTimeoutId);
        throw new Error("WebSocket mode not supported");
      }
      var streamResult;
      try {
        streamResult = await _parseSSEStream(res);
      } finally {
        clearTimeout(retryTimeoutId);
      }
      saveSession(sessionId);
      return {
        text: streamResult.text,
        messageId: streamResult.messageId,
        conversationId: _conversationId,
        generationId: streamResult.generationId,
        fileId: streamResult.fileId,
        generatedImages: streamResult.generatedImages,
      };
    }

    if (!res.ok) {
      clearTimeout(timeoutId);
      var err = await res.text().catch(function () {
        return "";
      });
      throw new Error(
        "ChatGPT API error (" + res.status + "): " + err.substring(0, 300),
      );
    }

    var resContentType = res.headers.get("content-type") || "";
    if (resContentType.startsWith("application/json")) {
      clearTimeout(timeoutId);
      throw new Error("WebSocket mode not supported");
    }

    var streamResult;
    try {
      streamResult = await _parseSSEStream(res);
    } finally {
      clearTimeout(timeoutId);
    }
    saveSession(sessionId);
    return {
      text: streamResult.text,
      messageId: streamResult.messageId,
      conversationId: _conversationId,
      generationId: streamResult.generationId,
      fileId: streamResult.fileId,
      generatedImages: streamResult.generatedImages,
    };
  }
  function getConversationId(sessionId) {
    if (!sessionId) sessionId = "default";
    var sess = _sessions[sessionId];
    return sess ? sess.conversationId : _conversationId;
  }

  function getSession(sessionId) {
    if (!sessionId) sessionId = _currentSessionId;
    var sess = sessionId ? _sessions[sessionId] : null;
    return sess
      ? {
          conversationId: sess.conversationId || null,
          parentMessageId: sess.parentMessageId || null,
        }
      : { conversationId: null, parentMessageId: null };
  }

  function setSession(sessionId, session) {
    if (!sessionId) throw new Error("A session id is required");
    _sessions[sessionId] = {
      conversationId: session && session.conversationId ? session.conversationId : null,
      parentMessageId: session && session.parentMessageId ? session.parentMessageId : null,
    };
    _pruneSessions();
    activateSession(sessionId);
  }

  function newConversation(sessionId) {
    if (sessionId) {
      delete _sessions[sessionId];
    } else if (_currentSessionId) {
      delete _sessions[_currentSessionId];
    }
    _conversationId = null;
    _parentMessageId = null;
    _currentSessionId = null;
    console.log(
      "[FluxNotes ChatGPT] Conversation reset:",
      sessionId || "current",
    );
  }

  async function _fetchBlobToBase64(url, fetchOpts, fallbackFileName) {
    var res = await fetch(url, fetchOpts);
    if (!res.ok) {
      var et = await res.text().catch(function () { return ""; });
      throw new Error("Image download failed (" + res.status + "): " + et.substring(0, 300));
    }
    var blob = await res.blob();
    var arrayBuffer = await blob.arrayBuffer();
    var bytes = new Uint8Array(arrayBuffer);
    var binary = "";
    for (var j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
    var base64 = btoa(binary);
    var mimeType = blob.type || null;
    if (!mimeType && fallbackFileName) {
      var m = fallbackFileName.match(/\.([a-zA-Z0-9]+)$/);
      if (m) {
        var ext = m[1].toLowerCase();
        if (ext === "png") mimeType = "image/png";
        else if (ext === "jpg" || ext === "jpeg") mimeType = "image/jpeg";
        else if (ext === "webp") mimeType = "image/webp";
        else if (ext === "gif") mimeType = "image/gif";
      }
    }
    return {
      base64: base64,
      mimeType: mimeType || "image/png",
      size: bytes.length,
    };
  }

  async function downloadSandboxImage(imagePath, messageId, sessionId) {
    console.log("[FluxNotes ChatGPT] Starting sandbox image download:", {
      imagePath: imagePath || null,
      messageId: messageId || null,
      sessionId: sessionId || null,
    });
    if (sessionId) activateSession(sessionId);
    var conversationId = _conversationId;
    if (!conversationId) throw new Error("No active conversation");
    if (!messageId) throw new Error("messageId is required");
    if (!imagePath) throw new Error("imagePath is required");

    var sandboxRel = imagePath;
    if (sandboxRel.indexOf("sandbox:") === 0) {
      sandboxRel = sandboxRel.substring("sandbox:".length);
    }
    if (sandboxRel.charAt(0) !== "/") sandboxRel = "/" + sandboxRel;

    var token = await _getToken();
    var deviceId = "";
    try {
      var cookies = document.cookie.split(";");
      for (var i = 0; i < cookies.length; i++) {
        var c = cookies[i].trim();
        if (c.startsWith("oai-did=")) {
          deviceId = c.substring(8);
          break;
        }
      }
    } catch (e) {}

    var headers = {
      Authorization: "Bearer " + token,
      "OAI-Language": "en-US",
    };
    if (deviceId) headers["OAI-Device-Id"] = deviceId;

    var fetchOpts = { credentials: "include", headers: headers };

    var url =
      "/backend-api/conversation/" +
      encodeURIComponent(conversationId) +
      "/interpreter/download?message_id=" +
      encodeURIComponent(messageId) +
      "&sandbox_path=" +
      encodeURIComponent(sandboxRel);

    console.log(
      "[FluxNotes ChatGPT] Resolving sandbox image:",
      sandboxRel,
      "message_id:",
      messageId,
    );

    var metaRes = await fetch(url, {
      method: "GET",
      credentials: fetchOpts.credentials,
      headers: fetchOpts.headers,
    });

    if (!metaRes.ok) {
      var errText = await metaRes.text().catch(function () {
        return "";
      });
      throw new Error(
        "Sandbox resolve failed (" + metaRes.status + "): " + errText.substring(0, 300),
      );
    }

    var downloadUrl = null;
    var info = { status: null, file_name: null, metadata: null };
    var contentType = (metaRes.headers && metaRes.headers.get) ? String(metaRes.headers.get("content-type") || "") : "";
    var rawMeta = await metaRes.text().catch(function () { return ""; });
    try {
      info = JSON.parse(rawMeta);
      if (info && typeof info.download_url === "string" && info.download_url.length > 0) {
        downloadUrl = info.download_url;
      }
    } catch (parseErr) {
      console.warn("[FluxNotes ChatGPT] Sandbox response was not JSON (content-type=" + contentType + "). Assuming direct binary.");
      downloadUrl = null;
    }

    var data;
    if (downloadUrl) {
      var absDownload = downloadUrl;
      if (absDownload.indexOf("http://") !== 0 && absDownload.indexOf("https://") !== 0 && absDownload.charAt(0) !== "/") {
        absDownload = "/" + absDownload;
      }
      console.log(
        "[FluxNotes ChatGPT] Got download_url. Fetching:",
        (absDownload.length > 120 ? absDownload.slice(0, 120) + "…" : absDownload),
      );
      data = await _fetchBlobToBase64(absDownload, fetchOpts, info ? info.file_name : null);
    } else {
      console.log("[FluxNotes ChatGPT] No download_url, interpreting response body as image bytes.");
      var blobFromMeta = rawMeta.length ? (new Blob([rawMeta])) : null;
      if (!blobFromMeta || blobFromMeta.size === 0) {
        throw new Error("Sandbox response contained no download_url and no image bytes.");
      }
      var ab = await blobFromMeta.arrayBuffer();
      var bs = new Uint8Array(ab);
      var bin = "";
      for (var k = 0; k < bs.length; k++) bin += String.fromCharCode(bs[k]);
      var b64 = btoa(bin);
      data = { base64: b64, mimeType: blobFromMeta.type || "image/png", size: bs.length };
    }

    console.log("[FluxNotes ChatGPT] Downloaded sandbox image. Size:", data.size, "type:", data.mimeType, "file:", info ? info.file_name : null, "imagePath:", imagePath);
    return {
      base64: data.base64,
      mimeType: data.mimeType,
      size: data.size,
      imagePath: imagePath,
      fileName: info ? info.file_name || null : null,
      fileId: (info && info.metadata && info.metadata.file_id) ? info.metadata.file_id : ((info && info.file_id) ? info.file_id : null),
      status: info ? info.status || null : null,
      downloadUrl: downloadUrl,
    };
  }

  window.__fluxnotesChatGPT = {
    send: send,
    newConversation: newConversation,
    uploadFileToChatGPT: uploadFileToChatGPT,
    getConversationId: getConversationId,
    getSession: getSession,
    setSession: setSession,
    downloadSandboxImage: downloadSandboxImage,
  };
  console.log("[FluxNotes ChatGPT] ChatGPT engine loaded");
  _getToken().catch(function () {});
  _getScriptsAndDpl().catch(function () {});
})();