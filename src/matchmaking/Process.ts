import * as express from "express";
import * as msgpack from "msgpack-lite";
import * as child_process from "child_process";
import * as memshared from "memshared";

import { Server as WebSocketServer } from "uws";
import { Protocol, send } from "../Protocol";
import { Client, generateId } from "../";

const app = new express();
const server = app.listen(0, "localhost")

let wss = new WebSocketServer({ server: server });
wss.on('connection', onConnect);

//
// Listen to "redirect" messages from main process, to redirect the connection
// to match-making process.
//
let callbacks: {[requestId:string]: Function} = {};
process.on('message', (message, connection) => {
  if (message === Protocol.BIND_CLIENT) {
    server.emit('connection', connection);
    connection.resume();
    return;

  } else if (Array.isArray(message) && callbacks[ message[0] ]) {
    let callback = callbacks[ message[0] ];
    callback(message[1]);
    return;
  }

});

// Process spawned successfully!
console.log("MatchMaking process spawned with pid", process.pid);

function onConnect (client: Client) {
  client.id = generateId();
  console.log("onConnect", client);

  client.on('message', (message) => {
    // try to decode message received from client
    try {
      message = msgpack.decode(Buffer.from(message));

    } catch (e) {
      console.error("Couldn't decode message:", message, e.stack);
      return;
    }

    if (message[0] !== Protocol.JOIN_ROOM) {
      console.error("MatchMaking couldn't process message:", message);
      return;
    }

    let roomName = message[1];
    let joinOptions = message[2];

    // has room handler avaialble?
    memshared.lindex("handlers", roomName, (err, index) => {
      if (index === -1) {
        send(client, [Protocol.JOIN_ERROR, roomName, `Error: no available handler for "${ roomName }"`]);
        return;
      }

      // retrieve active worker ids
      memshared.lrange("workerIds", 0, -1, (err, workerIds) => {

        // Request to join an existing sessions for requested handler
        memshared.smembers(roomName, (err, availableWorkerIds) => {
          let numAvaialbleWorkers = availableWorkerIds.length;
          console.log("numAvaialbleWorkers", numAvaialbleWorkers);

          // No workers has an instance of the requested handler.
          // Let's create an instance on a worker with fewer handler spawned.
          if (numAvaialbleWorkers === 0) {
            memshared.mget(availableWorkerIds, (err, spawnedRooms) => {
              let selectedWorkerId = (spawnedRooms.length > 0)
                ? workerIds[ spawnedRooms.indexOf(Math.min(...spawnedRooms)) ]
                : workerIds[0];

              callbacks[ client.id ] = handleResponse(client);

              // Send JOIN_ROOM command to selected worker process.
              process.send([ selectedWorkerId, Protocol.JOIN_ROOM, roomName, joinOptions, client.id ]);
            });

          } else {

            // Broadcast message and wait for the reply of every worker
            console.log("broadcasting raw message to other processes", message);
            process.send(message);

          }
        });

      });

    });



  });

  client.on('error', (e) => {
    console.error("[ERROR]", client, e);
  });
}

function handleResponse (client: Client) {
  return function (data) {
    console.log("handle response...", data);
    send(client, data);

    if (data[0] !== Protocol.JOIN_ERROR) {
      client.close();
    }
  }
}