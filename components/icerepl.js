// -*- js-indent-level: 2 -*-
"use strict";
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import('resource://gre/modules/XPCOMUtils.jsm');
Cu.import('resource://gre/modules/FileUtils.jsm');
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/Promise.jsm");

const { ConsoleAPI } = Cu.import("resource://gre/modules/devtools/Console.jsm");
const xcon = new ConsoleAPI({prefix: 'icerepl: '});
const threadManager = Cc["@mozilla.org/thread-manager;1"].getService();
const CC = Components.Constructor;
const UnixServerSocket =
      CC('@mozilla.org/network/server-socket;1',
         'nsIServerSocket',
         'initWithFilename');

const ScriptableInputStream =
      CC("@mozilla.org/scriptableinputstream;1",
         "nsIScriptableInputStream",
         "init");

var utf8conv = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
    .createInstance(Ci.nsIScriptableUnicodeConverter);
utf8conv.charset = 'utf-8';

var REQUEST = null;

function fromUtf8(s) {
  return utf8conv.ConvertToUnicode(s);
}

function toUtf8(s) {
  return utf8conv.ConvertFromUnicode(s);
}

function isWouldBlockException(e) {
  return (e instanceof Ci.nsIException &&
          e.result == Cr.NS_BASE_STREAM_WOULD_BLOCK);
}

function makeAsyncStreamPromise(obj, fn, ...args) {
  return new Promise(function(accept, reject) {
    var boundExecutor = function() {
      try {
        accept(fn.apply(obj, args));
      } catch(e if isWouldBlockException(e)) {
        obj.asyncWait(boundExecutor, 0, 0, threadManager.currentThread);
      } catch(e) {
        reject(e);
      }
    };
    boundExecutor();
  });
}

function asyncRead(stream, maximumBytes) {
  if(maximumBytes <= 0) {
    return '';
  }

  return makeAsyncStreamPromise(
    stream,
    function() {
      var ss = new ScriptableInputStream(stream);
      var n = Math.max(1, Math.min(maximumBytes, ss.available()));
      return ss.readBytes(n);
    }
  );
}

function* asyncReadAll(stream, total) {
  var ret = '';
  while(ret.length < total) {
    ret += yield asyncRead(stream, total - ret.length);
  }

  return ret;
}

function* asyncReadU4Le(stream) {
  var blob = yield asyncReadAll(stream, 4);
  return ((blob.charCodeAt(0) <<  0) |
          (blob.charCodeAt(1) <<  8) |
          (blob.charCodeAt(2) << 16) |
          (blob.charCodeAt(3) << 24));
}

function asyncWrite(stream, data) {
  return makeAsyncStreamPromise(stream, stream.write, data, data.length);
}

function* asyncWriteAll(stream, data) {
  while(data.length > 0) {
    data = data.slice(yield asyncWrite(stream, data));
  }
}

function asyncWriteU4Le(stream, data) {
  yield asyncWriteAll(
    stream,
    String.fromCharCode(
      (data >>  0) & 0xFF,
      (data >>  8) & 0xFF,
      (data >> 16) & 0xFF,
      (data >> 24) & 0xFF));
}

function asyncFlush(stream) {
  return makeAsyncStreamPromise(stream, stream.flush);
}

function* asyncReadBlob(stream) {
  return yield asyncReadAll(stream, yield asyncReadU4Le(stream));
}

function asyncWriteBlob(stream, blob) {
  yield asyncWriteU4Le(stream, blob.length);
  yield asyncWriteAll(stream, blob);
}

function genericJsonReplacer(key, value) {
  if(value instanceof Error) {
    return value.toString();
  }

  return value;
}

function genericToJson(value) {
  return JSON.stringify(value, genericJsonReplacer)
}

function* asyncHandleClient(aTransport) {
  try {
    var inp = aTransport.openInputStream(0, 0, 0)
        .QueryInterface(Ci.nsIAsyncInputStream);
    var out = aTransport.openOutputStream(0, 0, 0)
        .QueryInterface(Ci.nsIAsyncOutputStream);
    for(;;) {
      var requestBlob = yield asyncReadBlob(inp);
      var result = {};
      try {
        var request = JSON.parse(fromUtf8(requestBlob));
        REQUEST = request; // Make available to script
        result.value = eval.call(null, request.code);
        if(result.value === undefined) {
          result.value = null;
        }
      } catch(e) {
        result.error = e;
      }

      yield asyncWriteBlob(out, toUtf8(genericToJson(result)));
      yield asyncFlush(out);
    }
  } finally {
    aTransport.close(0);
  }
}

function onSocketAccepted(aServ, aTransport) {
  Task.spawn(asyncHandleClient(aTransport)).catch(
    function(e) {
      if (e instanceof Ci.nsIException
          && e.result != Cr.NS_BASE_STREAM_CLOSED)
      {
        xcon.error('exception from client', e);
      }
    });
}

function onStopListening(aServ, aStatus) {
  xcon.error('icerepl stopped listening: ' + aStatus);
}

function IcereplBootstrapper() {}
IcereplBootstrapper.prototype = {
  classDescription: 'Starts IceRepl',
  classID: Components.ID('{b5039230-05ee-4524-8d60-ff89f93fc4dc}'),
  contractID: (
    '@mozilla.org/commandlinehandler/general-startup;1?type=icerepl'),
  QueryInterface: XPCOMUtils.generateQI([Ci.nsICommandLineHandler]),

  handle: function IcereplBootstrapper_handle(aCommandLine) {
    // Construct a filename for our AF_UNIX socket
    let socket = FileUtils.getFile('ProfD', ['icerepl.socket']);

    // Remove any stale socket left over from a previous run
    try {
      socket.remove(false /*non-recursive*/);
    } catch(ex) {
      /* Noop */
    }

    // Bind our socket
    let serverSocket = new UnixServerSocket(
      socket,
      parseInt('700', 8),
      (-1));

    // Start listening
    serverSocket.asyncListen(
      {onSocketAccepted: onSocketAccepted,
       onStopListening: onStopListening });
  },

  helpInfo: '',
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([IcereplBootstrapper]);
