"use strict";
var co             = require('co');
var util           = require('util');
var async          = require('async');
var _              = require('underscore');
var Q              = require('q');
var events         = require('events');
var logger         = require('../lib/logger')('peering');
var base58         = require('../lib/base58');
var sha1           = require('sha1');
var moment         = require('moment');
var rawer          = require('../lib/rawer');
var constants      = require('../lib/constants');
var localValidator = require('../lib/localValidator');
var blockchainCtx   = require('../lib/blockchainContext');

function PeeringService(server, pair, dal) {

  var conf = server.conf;

  var Peer        = require('../lib/entity/peer');

  var selfPubkey = base58.encode(pair.publicKey);
  this.pubkey = selfPubkey;

  var peer = null;
  var that = this;

  this.setDAL = function(theDAL) {
    dal = theDAL;
  };

  this.peer = function (newPeer) {
    if (newPeer) {
      peer = newPeer;
    }
    return Peer.statics.peerize(peer);
  };

  this.submit = function(peering, eraseIfAlreadyRecorded, done){
    if (arguments.length == 2) {
      done = eraseIfAlreadyRecorded;
      eraseIfAlreadyRecorded = false;
    }
    return that.submitP(peering, eraseIfAlreadyRecorded)
    .then((res) => done(null, res))
    .catch(done);
  };

  this.submitP = function(peering, eraseIfAlreadyRecorded, cautious){
    let thePeer = new Peer(peering);
    let sp = thePeer.block.split('-');
    let blockNumber = sp[0];
    let blockHash = sp[1];
    let sigTime = 0;
    let block;
    let makeCheckings = cautious || cautious === undefined;
    return co(function *() {
      if (makeCheckings) {
        let goodSignature = localValidator(null).checkPeerSignature(thePeer);
        if (!goodSignature) {
          throw 'Signature from a peer must match';
        }
      }
      if (thePeer.block == constants.PEER.SPECIAL_BLOCK) {
        thePeer.statusTS = 0;
        thePeer.status = 'UP';
      } else {
        block = yield dal.getBlockByNumberAndHashOrNull(blockNumber, blockHash);
        if (!block && makeCheckings) {
          throw constants.PEER.UNKNOWN_REFERENCE_BLOCK;
        } else if (!block) {
          thePeer.block = constants.PEER.SPECIAL_BLOCK;
          thePeer.statusTS = 0;
          thePeer.status = 'UP';
        }
      }
      sigTime = block ? block.medianTime : 0;
      thePeer.statusTS = sigTime;
      let found = yield dal.getPeerOrNull(thePeer.pubkey);
      var peerEntity = Peer.statics.peerize(found || thePeer);
      if(found){
        // Already existing peer
        var sp2 = found.block.split('-');
        var previousBlockNumber = sp2[0];
        if(blockNumber <= previousBlockNumber && !eraseIfAlreadyRecorded){
          throw constants.ERROR.PEER.ALREADY_RECORDED;
        }
        peerEntity = Peer.statics.peerize(found);
        thePeer.copyValues(peerEntity);
        peerEntity.sigDate = new Date(sigTime * 1000);
      }
      // Set the peer as UP again
      peerEntity.status = 'UP';
      peerEntity.first_down = null;
      peerEntity.last_try = null;
      peerEntity.hash = String(sha1(peerEntity.getRawSigned())).toUpperCase();
      yield dal.savePeer(peerEntity);
      let res = Peer.statics.peerize(peerEntity);
      return res;
    });
  };

  var peerFifo = async.queue(function (task, callback) {
    task(callback);
  }, 1);
  var peerInterval = null;
  this.regularPeerSignal = function (done) {
    let signalTimeInterval = 1000 * conf.avgGenTime * constants.NETWORK.STATUS_INTERVAL.UPDATE;
    if (peerInterval)
      clearInterval(peerInterval);
    peerInterval = setInterval(function () {
      peerFifo.push(_.partial(generateSelfPeer, conf, signalTimeInterval));
    }, signalTimeInterval);
    generateSelfPeer(conf, signalTimeInterval, done);
  };

  var syncBlockFifo = async.queue((task, callback) => task(callback), 1);
  var syncBlockInterval = null;
  this.regularSyncBlock = function (done) {
    if (syncBlockInterval)
      clearInterval(syncBlockInterval);
    syncBlockInterval = setInterval(()  => syncBlockFifo.push(syncBlock), 1000*conf.avgGenTime*constants.NETWORK.SYNC_BLOCK_INTERVAL);
    syncBlock(done);
  };

  const FIRST_CALL = true;
  var testPeerFifo = async.queue((task, callback) => task(callback), 1);
  var testPeerFifoInterval = null;
  this.regularTestPeers = function (done) {
    if (testPeerFifoInterval)
      clearInterval(testPeerFifoInterval);
    testPeerFifoInterval = setInterval(() => testPeerFifo.push(testPeers.bind(null, !FIRST_CALL)), 1000 * conf.avgGenTime * constants.NETWORK.TEST_PEERS_INTERVAL);
    testPeers(FIRST_CALL, done);
  };

  this.generateSelfPeer = generateSelfPeer;

  function generateSelfPeer(theConf, signalTimeInterval, done) {
    return co(function *() {
      let current = yield server.dal.getCurrentBlockOrNull();
      let currency = theConf.currency;
      let peers = yield dal.findPeers(selfPubkey);
      let p1 = { version: 1, currency: currency };
      if(peers.length != 0){
        p1 = _(peers[0]).extend({ version: 1, currency: currency });
      }
      let endpoint = 'BASIC_MERKLED_API';
      if (theConf.remotehost) {
        endpoint += ' ' + theConf.remotehost;
      }
      if (theConf.remoteipv4) {
        endpoint += ' ' + theConf.remoteipv4;
      }
      if (theConf.remoteipv6) {
        endpoint += ' ' + theConf.remoteipv6;
      }
      if (theConf.remoteport) {
        endpoint += ' ' + theConf.remoteport;
      }
      if (!currency || endpoint == 'BASIC_MERKLED_API') {
        logger.error('It seems there is an issue with your configuration.');
        logger.error('Please restart your node with:');
        logger.error('$ ucoind restart');
        return Q.Promise((resolve) => null);
      }
      // Choosing next based-block for our peer record: we basically want the most distant possible from current
      let minBlock = current ? current.number - 30 : 0;
      // But if already have a peer record within this distance, we need to take the next block of it
      if (p1) {
        let p1Block = parseInt(p1.block.split('-')[0], 10);
        minBlock = Math.max(minBlock, p1Block + 1);
      }
      // Finally we can't have a negative block
      minBlock = Math.max(0, minBlock);
      let targetBlock = yield server.dal.getBlockOrNull(minBlock);
      var p2 = {
        version: 1,
        currency: currency,
        pubkey: selfPubkey,
        block: targetBlock ? [targetBlock.number, targetBlock.hash].join('-') : constants.PEER.SPECIAL_BLOCK,
        endpoints: [endpoint]
      };
      var raw1 = new Peer(p1).getRaw().dos2unix();
      var raw2 = new Peer(p2).getRaw().dos2unix();
      logger.info('External access:', new Peer(raw1 == raw2 ? p1 : p2).getURL());
      if (raw1 != raw2) {
        logger.debug('Generating server\'s peering entry based on block#%s...', p2.block.split('-')[0]);
        p2.signature = yield Q.nfcall(server.sign, raw2);
        p2.pubkey = selfPubkey;
        p2.documentType = 'peer';
        // Submit & share with the network
        yield server.submitP(p2, false);
      } else {
        p1.documentType = 'peer';
        // Share with the network
        server.push(p1);
      }
      let selfPeer = yield dal.getPeer(selfPubkey);
      // Set peer's statut to UP
      selfPeer.documentType = 'selfPeer';
      that.peer(selfPeer);
      server.push(selfPeer);
      logger.info("Next peering signal in %s min", signalTimeInterval / 1000 / 60);
    })
      .then(() => done())
      .catch(done);
  }

  function testPeers(displayDelays, done) {
    return co(function *() {
      let peers = yield dal.listAllPeers();
      let now = (new Date().getTime());
      peers = _.filter(peers, (p) => p.pubkey != selfPubkey);
      for (let i = 0, len = peers.length; i < len; i++) {
        let p = new Peer(peers[i]);
        if (p.status == 'DOWN') {
          let shouldDisplayDelays = displayDelays;
          let downAt = p.first_down || now;
          let downDelay = Math.floor((now - downAt) / 1000);
          let waitedSinceLastTest = Math.floor((now - (p.last_try || now)) / 1000);
          let waitRemaining = downDelay <= constants.DURATIONS.A_MINUTE ? constants.DURATIONS.TEN_SECONDS - waitedSinceLastTest : (
            downDelay <= constants.DURATIONS.TEN_MINUTES ?             constants.DURATIONS.A_MINUTE - waitedSinceLastTest : (
            downDelay <= constants.DURATIONS.AN_HOUR ?                 constants.DURATIONS.TEN_MINUTES - waitedSinceLastTest : (
            downDelay <= constants.DURATIONS.A_DAY ?                   constants.DURATIONS.AN_HOUR - waitedSinceLastTest : (
            downDelay <= constants.DURATIONS.A_WEEK ?                  constants.DURATIONS.A_DAY - waitedSinceLastTest : (
            downDelay <= constants.DURATIONS.A_MONTH ?                 constants.DURATIONS.A_WEEK - waitedSinceLastTest :
            1 // Do not check it, DOWN for too long
          )))));
          let testIt = waitRemaining <= 0;
          if (testIt) {
            // We try to reconnect only with peers marked as DOWN
            try {
              logger.info('Checking if node %s (%s:%s) is UP...', p.pubkey.substr(0, 6), p.getHostPreferDNS(), p.getPort());
              let node = yield Q.nfcall(p.connect);
              let peering = yield Q.nfcall(node.network.peering.get);
              let sp1 = peering.block.split('-');
              let currentBlockNumber = sp1[0];
              let currentBlockHash = sp1[1];
              let sp2 = peering.block.split('-');
              let blockNumber = sp2[0];
              let blockHash = sp2[1];
              if (!(currentBlockNumber == blockNumber && currentBlockHash == blockHash)) {
                // The peering changed
                yield Q.nfcall(that.submit, peering);
              }
            } catch (err) {
              // Error: we set the peer as DOWN
              logger.warn("Peer record %s: %s", p.pubkey, err.code || err.message || err);
              yield dal.setPeerDown(p.pubkey);
              shouldDisplayDelays = true;
            }
          }
          if (shouldDisplayDelays) {
            logger.info('Will check that node %s (%s:%s) is UP in %s min...', p.pubkey.substr(0, 6), p.getHostPreferDNS(), p.getPort(), (waitRemaining / 60).toFixed(0));
          }
        }
      }
      done();
    })
      .catch(done);
  }

  function syncBlock(callback) {
    return co(function *() {
      let current = yield dal.getCurrentBlockOrNull();
      if (current) {
        logger.info("Check network for new blocks...");
        let peers = yield dal.findAllPeersNEWUPBut([selfPubkey]);
        peers = _.shuffle(peers);
        for (let i = 0, len = peers.length; i < len; i++) {
          var p = new Peer(peers[i]);
          logger.info("Try with %s %s", p.getURL(), p.pubkey.substr(0, 6));
          let node = yield Q.nfcall(p.connect);
          let okUP = yield processAscendingUntilNoBlock(p, node, current);
          if (okUP) {
            let remoteCurrent = yield Q.nfcall(node.blockchain.current);
            // We check if our current block has changed due to ascending pulling
            let nowCurrent = yield dal.getCurrentBlockOrNull();
            logger.debug("Remote #%s Local #%s", remoteCurrent.number, nowCurrent.number);
            if (remoteCurrent.number != nowCurrent.number) {
              yield processLastTen(p, node, nowCurrent);
            }
          }
          try {
            // Try to fork as a final treatment
            let nowCurrent = yield dal.getCurrentBlockOrNull();
            yield server.BlockchainService.tryToFork(nowCurrent);
          } catch (e) {
            logger.warn(e);
          }
        }
      }
      callback();
    })
      .catch((err) => {
        logger.warn(err.code || err.stack || err.message || err);
        callback();
      });
  }

  function isConnectionError(err) {
    return err && (err.code == "EINVAL" || err.code == "ECONNREFUSED");
  }

  function processAscendingUntilNoBlock(p, node, current) {
    return co(function *() {
      try {
        let downloaded = yield Q.nfcall(node.blockchain.block, current.number + 1);
        if (!downloaded) {
          yield dal.setPeerDown(p.pubkey);
        }
        while (downloaded) {
          logger.info("Downloaded block #%s from peer %s", downloaded.number, p.getNamedURL());
          downloaded = rawifyTransactions(downloaded);
          try {
            let res = yield server.BlockchainService.submitBlock(downloaded, true);
            if (!res.fork) {
              let nowCurrent = yield dal.getCurrentBlockOrNull();
              yield server.BlockchainService.tryToFork(nowCurrent);
            }
          } catch (err) {
            console.log(err);
            if (isConnectionError(err)) {
              throw err;
            }
          }
          if (downloaded.number == 0) {
            downloaded = null;
          } else {
            downloaded = yield Q.nfcall(node.blockchain.block, downloaded.number + 1);
          }
        }
      } catch (err) {
        logger.warn(err.code || err.message || err);
        if (isConnectionError(err)) {
          yield dal.setPeerDown(p.pubkey);
          return false;
        }
      }
      return true;
    });
  }

  function processLastTen(p, node, current) {
    return co(function *() {
      try {
        let downloaded = yield Q.nfcall(node.blockchain.block, current.number);
        if (!downloaded) {
          yield dal.setPeerDown(p.pubkey);
        }
        while (downloaded) {
          logger.info("Downloaded block #%s from peer %s", downloaded.number, p.getNamedURL());
          downloaded = rawifyTransactions(downloaded);
          try {
            let res = yield server.BlockchainService.submitBlock(downloaded, true);
            if (!res.fork) {
              let nowCurrent = yield dal.getCurrentBlockOrNull();
              yield server.BlockchainService.tryToFork(nowCurrent);
            }
          } catch (err) {
            console.log(err);
            if (isConnectionError(err)) {
              throw err;
            }
          }
          if (downloaded.number == 0 || downloaded.number <= current.number - 10) {
            downloaded = null;
          } else {
            downloaded = yield Q.nfcall(node.blockchain.block, downloaded.number - 1);
          }
        }
      } catch (err) {
        logger.warn(err.code || err.message || err);
        if (isConnectionError(err)) {
          yield dal.setPeerDown(p.pubkey);
        }
        return false;
      }
      return true;
    });
  }

  function rawifyTransactions(block) {
    // Rawification of transactions
    block.transactions.forEach(function (tx) {
      tx.raw = ["TX", "1", tx.signatories.length, tx.inputs.length, tx.outputs.length, tx.comment ? '1' : '0'].join(':') + '\n';
      tx.raw += tx.signatories.join('\n') + '\n';
      tx.raw += tx.inputs.join('\n') + '\n';
      tx.raw += tx.outputs.join('\n') + '\n';
      if (tx.comment)
        tx.raw += tx.comment + '\n';
      tx.raw += tx.signatures.join('\n') + '\n';
      tx.version = 1;
      tx.currency = conf.currency;
      tx.issuers = tx.signatories;
      tx.hash = ("" + sha1(rawer.getTransaction(tx))).toUpperCase();
    });
    return block;
  }
}

util.inherits(PeeringService, events.EventEmitter);

module.exports = function (server, pair, dal) {
  return new PeeringService(server, pair, dal);
};
