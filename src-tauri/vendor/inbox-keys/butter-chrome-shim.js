// Butter's stand-in for the chrome.* APIs Inbox Keys' content scripts use.
// Not part of upstream Inbox Keys.
//
// - chrome.storage.local keeps settings in the page's localStorage under
//   "butter-inboxkeys:<key>", so they persist per site (mail.google.com and
//   calendar.google.com each keep their own copy).
// - chrome.storage.onChanged fires for changes made here and, through the
//   "storage" event, for changes made by another Butter browser pane.
// - chrome.runtime.onMessage only fed the extension's popup, which Butter
//   doesn't have, so listeners are accepted and never called.
var chrome = (function () {
  var PREFIX = "butter-inboxkeys:";
  var listeners = [];

  function read(key) {
    try {
      var raw = window.localStorage.getItem(PREFIX + key);
      return raw == null ? undefined : JSON.parse(raw);
    } catch (e) {
      return undefined;
    }
  }

  function write(key, value) {
    try {
      if (value === undefined) window.localStorage.removeItem(PREFIX + key);
      else window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
      console.warn("[InboxKeys] could not save setting", key, e);
    }
  }

  function storedKeys() {
    var keys = [];
    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) keys.push(k.slice(PREFIX.length));
      }
    } catch (e) {}
    return keys;
  }

  function notify(changes) {
    if (!Object.keys(changes).length) return;
    setTimeout(function () {
      listeners.slice().forEach(function (cb) {
        try {
          cb(changes, "local");
        } catch (e) {
          console.error("[InboxKeys] storage listener failed", e);
        }
      });
    }, 0);
  }

  // chrome.* calls take an optional callback and otherwise return a promise.
  function finish(value, cb) {
    if (typeof cb === "function") {
      setTimeout(function () {
        cb(value);
      }, 0);
      return undefined;
    }
    return Promise.resolve(value);
  }

  var local = {
    get: function (keys, cb) {
      if (typeof keys === "function") {
        cb = keys;
        keys = null;
      }
      var out = {};
      if (keys == null) {
        storedKeys().forEach(function (k) {
          out[k] = read(k);
        });
      } else if (typeof keys === "string" || Array.isArray(keys)) {
        [].concat(keys).forEach(function (k) {
          var v = read(k);
          if (v !== undefined) out[k] = v;
        });
      } else {
        Object.keys(keys).forEach(function (k) {
          var v = read(k);
          out[k] = v === undefined ? keys[k] : v;
        });
      }
      return finish(out, cb);
    },
    set: function (items, cb) {
      var changes = {};
      Object.keys(items || {}).forEach(function (k) {
        var oldValue = read(k);
        write(k, items[k]);
        changes[k] = { oldValue: oldValue, newValue: items[k] };
      });
      notify(changes);
      return finish(undefined, cb);
    },
    remove: function (keys, cb) {
      var changes = {};
      [].concat(keys).forEach(function (k) {
        var oldValue = read(k);
        if (oldValue === undefined) return;
        write(k, undefined);
        changes[k] = { oldValue: oldValue };
      });
      notify(changes);
      return finish(undefined, cb);
    },
    clear: function (cb) {
      return local.remove(storedKeys(), cb);
    },
  };

  window.addEventListener("storage", function (e) {
    if (!e.key || e.key.indexOf(PREFIX) !== 0) return;
    var parse = function (raw) {
      try {
        return raw == null ? undefined : JSON.parse(raw);
      } catch (err) {
        return undefined;
      }
    };
    var change = {};
    change[e.key.slice(PREFIX.length)] = { oldValue: parse(e.oldValue), newValue: parse(e.newValue) };
    notify(change);
  });

  var noopEvent = { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } };

  return {
    storage: {
      local: local,
      onChanged: {
        addListener: function (cb) {
          listeners.push(cb);
        },
        removeListener: function (cb) {
          listeners = listeners.filter(function (l) {
            return l !== cb;
          });
        },
        hasListener: function (cb) {
          return listeners.indexOf(cb) !== -1;
        },
      },
    },
    runtime: {
      id: "butter-inbox-keys",
      onMessage: noopEvent,
      onInstalled: noopEvent,
      sendMessage: function () {
        var cb = arguments[arguments.length - 1];
        return finish(undefined, typeof cb === "function" ? cb : undefined);
      },
    },
  };
})();

