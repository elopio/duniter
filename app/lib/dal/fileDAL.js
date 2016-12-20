"use strict";
const Q       = require('q');
const co      = require('co');
const _       = require('underscore');
const indexer = require('../dup/indexer');
const hashf   = require('../ucp/hashf');
const wotb    = require('../wot');
const logger = require('../logger')('filedal');
const directory = require('../system/directory');
const Configuration = require('../entity/configuration');
const Membership = require('../entity/membership');
const Merkle = require('../entity/merkle');
const Transaction = require('../entity/transaction');
const constants = require('../constants');
const ConfDAL = require('./fileDALs/confDAL');
const StatDAL = require('./fileDALs/statDAL');
const IndicatorsDAL = require('./fileDALs/IndicatorsDAL');
const CFSStorage = require('./fileDALs/AbstractCFS');

module.exports = (params) => {
  return new FileDAL(params);
};

function FileDAL(params) {

  const rootPath = params.home;
  const myFS = params.fs;
  const sqliteDriver = params.dbf();
  const wotbInstance = params.wotb;
  const that = this;

  this.profile = 'DAL';
  this.wotb = wotbInstance;

  // DALs
  this.confDAL = new ConfDAL(rootPath, myFS, null, that, CFSStorage);
  this.metaDAL = new (require('./sqliteDAL/MetaDAL'))(sqliteDriver);
  this.peerDAL = new (require('./sqliteDAL/PeerDAL'))(sqliteDriver);
  this.blockDAL = new (require('./sqliteDAL/BlockDAL'))(sqliteDriver);
  this.sourcesDAL = new (require('./sqliteDAL/SourcesDAL'))(sqliteDriver);
  this.txsDAL = new (require('./sqliteDAL/TxsDAL'))(sqliteDriver);
  this.indicatorsDAL = new IndicatorsDAL(rootPath, myFS, null, that, CFSStorage);
  this.statDAL = new StatDAL(rootPath, myFS, null, that, CFSStorage);
  this.idtyDAL = new (require('./sqliteDAL/IdentityDAL'))(sqliteDriver, wotbInstance);
  this.certDAL = new (require('./sqliteDAL/CertDAL'))(sqliteDriver);
  this.msDAL = new (require('./sqliteDAL/MembershipDAL'))(sqliteDriver);
  this.bindexDAL = new (require('./sqliteDAL/index/BIndexDAL'))(sqliteDriver);
  this.mindexDAL = new (require('./sqliteDAL/index/MIndexDAL'))(sqliteDriver);
  this.iindexDAL = new (require('./sqliteDAL/index/IIndexDAL'))(sqliteDriver);
  this.sindexDAL = new (require('./sqliteDAL/index/SIndexDAL'))(sqliteDriver);
  this.cindexDAL = new (require('./sqliteDAL/index/CIndexDAL'))(sqliteDriver);

  this.newDals = {
    'metaDAL': that.metaDAL,
    'blockDAL': that.blockDAL,
    'certDAL': that.certDAL,
    'msDAL': that.msDAL,
    'idtyDAL': that.idtyDAL,
    'sourcesDAL': that.sourcesDAL,
    'txsDAL': that.txsDAL,
    'peerDAL': that.peerDAL,
    'indicatorsDAL': that.indicatorsDAL,
    'confDAL': that.confDAL,
    'statDAL': that.statDAL,
    'ghostDAL': {
      init: () => co(function *() {

        // Create extra views (useful for stats or debug)
        return that.blockDAL.exec('BEGIN;' +
            'CREATE VIEW IF NOT EXISTS identities_pending AS SELECT * FROM idty WHERE NOT written;' +
            'CREATE VIEW IF NOT EXISTS certifications_pending AS SELECT * FROM cert WHERE NOT written;' +
            'CREATE VIEW IF NOT EXISTS transactions_pending AS SELECT * FROM txs WHERE NOT written;' +
            'CREATE VIEW IF NOT EXISTS transactions_desc AS SELECT * FROM txs ORDER BY time DESC;' +
            'CREATE VIEW IF NOT EXISTS forks AS SELECT number, hash, issuer, monetaryMass, dividend, UDTime, membersCount, medianTime, time, * FROM block WHERE fork ORDER BY number DESC;' +
            'CREATE VIEW IF NOT EXISTS blockchain AS SELECT number, hash, issuer, monetaryMass, dividend, UDTime, membersCount, medianTime, time, * FROM block WHERE NOT fork ORDER BY number DESC;' +
            'CREATE VIEW IF NOT EXISTS network AS select i.uid, (last_try - first_down) / 1000 as down_delay_in_sec, p.* from peer p LEFT JOIN idty i on i.pubkey = p.pubkey ORDER by down_delay_in_sec;' +
            'COMMIT;');
      })
    },
    'bindexDAL': that.bindexDAL,
    'mindexDAL': that.mindexDAL,
    'iindexDAL': that.iindexDAL,
    'sindexDAL': that.sindexDAL,
    'cindexDAL': that.cindexDAL
  };

  let currency = '';

  this.init = () => co(function *() {
    const dalNames = _.keys(that.newDals);
    for (const dalName of dalNames) {
      const dal = that.newDals[dalName];
      yield dal.init();
    }
    logger.debug("Upgrade database...");
    yield that.metaDAL.upgradeDatabase();
    const latestMember = yield that.idtyDAL.getLatestMember();
    if (latestMember && that.wotb.getWoTSize() > latestMember.wotb_id + 1) {
      logger.warn('Maintenance: cleaning wotb...');
      while (that.wotb.getWoTSize() > latestMember.wotb_id + 1) {
        that.wotb.removeNode();
      }
    }
    // Update the maximum certifications count a member can issue into the C++ addon
    const currencyParams = yield that.getParameters();
    if (currencyParams && currencyParams.sigStock !== undefined && currencyParams.sigStock !== null) {
      that.wotb.setMaxCert(currencyParams.sigStock);
    }
  });

  this.getDBVersion = () => that.metaDAL.getVersion();

  this.getCurrency = () => currency;

  that.writeFileOfBlock = (block) => that.blockDAL.saveBlock(block);

  this.writeSideFileOfBlock = (block) =>
      that.blockDAL.saveSideBlock(block);

  this.listAllPeers = () => that.peerDAL.listAll();

  this.getPeer = (pubkey) => co(function*() {
    try {
      return that.peerDAL.getPeer(pubkey)
    } catch (err) {
      throw Error('Unknown peer ' + pubkey);
    }
  });

  this.getBlock = (number) => co(function*() {
    const block = yield that.blockDAL.getBlock(number);
    return block || null;
  });

  this.getAbsoluteBlockByNumberAndHash = (number, hash) =>
      that.blockDAL.getAbsoluteBlock(number, hash);

  this.getBlockByBlockstampOrNull = (blockstamp) => {
    if (!blockstamp) throw "Blockstamp is required to find the block";
    const sp = blockstamp.split('-');
    const number = parseInt(sp[0]);
    const hash = sp[1];
    return that.getBlockByNumberAndHashOrNull(number, hash);
  };

  this.getBlockByBlockstamp = (blockstamp) => {
    if (!blockstamp) throw "Blockstamp is required to find the block";
    const sp = blockstamp.split('-');
    const number = parseInt(sp[0]);
    const hash = sp[1];
    return that.getBlockByNumberAndHash(number, hash);
  };

  this.getBlockByNumberAndHash = (number, hash) => co(function*() {
    try {
      const block = yield that.getBlock(number);
      if (!block || block.hash != hash)
        throw "Not found";
      else
        return block;
    } catch (err) {
      throw 'Block ' + [number, hash].join('-') + ' not found';
    }
  });

  this.getBlockByNumberAndHashOrNull = (number, hash) => co(function*() {
    try {
      return yield that.getBlockByNumberAndHash(number, hash);
    } catch (e) {
      return null;
    }
  });

  this.existsNonChainableLink = (from, vHEAD_1, sigStock) => co(function *() {
    // Cert period rule
    const medianTime = vHEAD_1 ? vHEAD_1.medianTime : 0;
    const linksFrom = yield that.cindexDAL.reducablesFrom(from);
    const unchainables = _.filter(linksFrom, (link) => link.chainable_on > medianTime);
    if (unchainables.length > 0) return true;
    // Max stock rule
    let activeLinks = _.filter(linksFrom, (link) => !link.expired_on);
    return activeLinks.length >= sigStock;
  });


  this.getCurrentBlockOrNull = () => co(function*() {
    let current = null;
    try {
      current = yield that.getBlockCurrent();
    } catch (e) {
      if (e != constants.ERROR.BLOCK.NO_CURRENT_BLOCK) {
        throw e;
      }
    }
    return current;
  });

  this.getPromoted = (number) => that.getBlock(number);

  // Block
  this.lastUDBlock = () => that.blockDAL.lastBlockWithDividend();

  this.getRootBlock = () => that.getBlock(0);

  this.lastBlockOfIssuer = function (issuer) {
    return that.blockDAL.lastBlockOfIssuer(issuer);
  };
  
  this.getCountOfPoW = (issuer) => that.blockDAL.getCountOfBlocksIssuedBy(issuer);

  this.getBlocksBetween = (start, end) => Q(this.blockDAL.getBlocks(Math.max(0, start), end));

  this.getForkBlocksFollowing = (current) => this.blockDAL.getNextForkBlocks(current.number, current.hash);

  this.getBlockCurrent = () => co(function*() {
    const current = yield that.blockDAL.getCurrent();
    if (!current)
      throw 'No current block';
    return current;
  });

  this.getValidLinksTo = (to) => that.cindexDAL.getValidLinksTo(to);

  this.getAvailableSourcesByPubkey = function (pubkey) {
    return that.sourcesDAL.getAvailableForPubkey(pubkey);
  };

  this.getIdentityByHashOrNull = (hash) => that.idtyDAL.getByHash(hash);

  this.getMembers = () => co(function*() {
    const idties = yield that.idtyDAL.getWhoIsOrWasMember()
    return _.chain(idties).where({member: true}).value();
  });

  // TODO: this should definitely be reduced by removing fillInMembershipsOfIdentity
  this.getWritten = (pubkey) => co(function*() {
    try {
      return yield that.fillInMembershipsOfIdentity(that.idtyDAL.getFromPubkey(pubkey));
    } catch (err) {
      logger.error(err);
      return null;
    }
  });

  this.getWrittenIdtyByPubkey = (pubkey) => this.idtyDAL.getFromPubkey(pubkey);
  this.getWrittenIdtyByUID = (pubkey) => this.idtyDAL.getFromUID(pubkey);

  this.fillInMembershipsOfIdentity = (queryPromise) => co(function*() {
    try {
      const idty = yield Q(queryPromise);
      if (idty) {
        const mss = yield that.msDAL.getMembershipsOfIssuer(idty.pubkey);
        idty.memberships = mss;
        return idty;
      }
    } catch (err) {
      logger.error(err);
    }
    return null;
  });

  this.findPeersWhoseHashIsIn = (hashes) => co(function*() {
    const peers = yield that.peerDAL.listAll();
    return _.chain(peers).filter((p) => hashes.indexOf(p.hash) !== -1).value();
  });

  this.getTxByHash = (hash) => that.txsDAL.getTX(hash);

  this.removeTxByHash = (hash) => that.txsDAL.removeTX(hash);

  this.getTransactionsPending = (versionMin) => that.txsDAL.getAllPending(versionMin);

  this.getNonWritten = (pubkey) => co(function*() {
    const pending = yield that.idtyDAL.getPendingIdentities();
    return _.chain(pending).where({pubkey: pubkey}).value();
  });

  this.getToBeKicked = () => co(function*() {
    const membersOnce = yield that.idtyDAL.getWhoIsOrWasMember();
    return _.chain(membersOnce).where({member: true, kick: true}).value();
  });

  this.getRevocatingMembers = () => co(function *() {
    return that.idtyDAL.getToRevoke();
  });

  this.getToBeKickedPubkeys = () => co(function *() {
    const exclusions = yield that.getToBeKicked();
    return _.pluck(exclusions, 'pubkey');
  });

  this.searchJustIdentities = (search) => this.idtyDAL.searchThoseMatching(search);

  this.certsToTarget = (hash) => co(function*() {
    const certs = yield that.certDAL.getToTarget(hash);
    const matching = _.chain(certs).sortBy((c) => -c.block).value();
    matching.reverse();
    return matching;
  });

  this.certsFrom = (pubkey) => co(function*() {
    const certs = yield that.certDAL.getFromPubkey(pubkey);
    return _.chain(certs).where({from: pubkey}).sortBy((c) => c.block).value();
  });

  this.certsFindNew = () => co(function*() {
    const certs = yield that.certDAL.getNotLinked();
    return _.chain(certs).where({linked: false}).sortBy((c) => -c.block).value();
  });

  this.certsNotLinkedToTarget = (hash) => co(function*() {
    const certs = yield that.certDAL.getNotLinkedToTarget(hash);
    return _.chain(certs).sortBy((c) => -c.block).value();
  });

  this.getMembershipForHashAndIssuer = (ms) => co(function*() {
    try {
      return that.msDAL.getMembershipOfIssuer(ms);
    } catch (err) {
      return null;
    }
  });

  this.lastJoinOfIdentity = (target) => co(function *() {
    let pending = yield that.msDAL.getPendingINOfTarget(target);
    return _(pending).sortBy((ms) => -ms.number)[0];
  });

  this.findNewcomers = () => co(function*() {
    const mss = yield that.msDAL.getPendingIN();
    return _.chain(mss).sortBy((ms) => -ms.sigDate).value();
  });

  this.findLeavers = () => co(function*() {
    const mss = yield that.msDAL.getPendingOUT();
    return _.chain(mss).sortBy((ms) => -ms.sigDate).value();
  });

  this.existsNonReplayableLink = (from, to) => co(function *() {
    const links = yield that.cindexDAL.existsNonReplayableLink(from, to);
    return links.length ? true : false;
  });

  this.getSource = (identifier, noffset) => co(function*() {
    // TODO: remove for version 1.0
    let src = yield that.sourcesDAL.getSource(identifier, noffset);
    // If the source does not exist, we try to check if it exists under another form (issue #735)
    if (!src) {
      let txs = yield that.txsDAL.getTransactionByExtendedHash(identifier);
      if (txs.length > 1) {
        throw constants.ERRORS.INCONSISTENT_DB_MULTI_TXS_SAME_HASH;
      }
      if (txs.length && txs[0].version == 3) {
        // Other try: V4
        src = yield that.sourcesDAL.getSource(txs[0].v4_hash, noffset);
        if (!src) {
          // Another try: V5
          src = yield that.sourcesDAL.getSource(txs[0].v5_hash, noffset);
        }
        if (!src) {
          // Final try: V3 (because identifier maybe be one of [hash, v4_hash, v5_hash]
          src = yield that.sourcesDAL.getSource(txs[0].hash, noffset);
        }
      }
    }
    return src;
  });

  this.isMember = (pubkey) => co(function*() {
    try {
      const idty = yield that.idtyDAL.getFromPubkey(pubkey);
      return idty.member;
    } catch (err) {
      return false;
    }
  });

  this.isMemberAndNonLeaver = (pubkey) => co(function*() {
    try {
      const idty = yield that.idtyDAL.getFromPubkey(pubkey);
      return (idty && idty.member && !idty.leaving || false);
    } catch (err) {
      return false;
    }
  });

  this.existsCert = (cert) => that.certDAL.existsGivenCert(cert);

  this.setConsumedSource = (identifier, noffset) => that.sourcesDAL.consumeSource(identifier, noffset);

  this.setKicked = (pubkey, hash, notEnoughLinks) => co(function*() {
    const kick = notEnoughLinks ? true : false;
    const idty = yield that.idtyDAL.getFromPubkey(pubkey);
    if (idty.kick != kick) {
      idty.kick = kick;
      return yield that.idtyDAL.saveIdentity(idty);
    }
  });

  this.setRevocating = (hash, revocation_sig) => co(function *() {
    let idty = yield that.idtyDAL.getByHash(hash);
    idty.revocation_sig = revocation_sig;
    return that.idtyDAL.saveIdentity(idty);
  });

  this.getMembershipExcludingBlock = (current, msValidtyTime) => getCurrentExcludingOrExpiring(
    current,
    msValidtyTime,
    that.indicatorsDAL.getCurrentMembershipExcludingBlock.bind(that.indicatorsDAL),
    that.indicatorsDAL.writeCurrentExcluding.bind(that.indicatorsDAL)
  );

  this.getMembershipRevocatingBlock = (current, msValidtyTime) => getCurrentExcludingOrExpiring(
    current,
    msValidtyTime,
    that.indicatorsDAL.getCurrentMembershipRevocatingBlock.bind(that.indicatorsDAL),
    that.indicatorsDAL.writeCurrentRevocating.bind(that.indicatorsDAL)
  );

  this.getCertificationExcludingBlock = (current, certValidtyTime) => getCurrentExcludingOrExpiring(
    current,
    certValidtyTime,
    that.indicatorsDAL.getCurrentCertificationExcludingBlock.bind(that.indicatorsDAL),
    that.indicatorsDAL.writeCurrentExcludingForCert.bind(that.indicatorsDAL)
  );

  this.getIdentityExpiringBlock = (current, idtyValidtyTime) => getCurrentExcludingOrExpiring(
    current,
    idtyValidtyTime,
    that.indicatorsDAL.getCurrentIdentityExpiringBlock.bind(that.indicatorsDAL),
    that.indicatorsDAL.writeCurrentExpiringForIdty.bind(that.indicatorsDAL)
  );

  this.getCertificationExpiringBlock = (current, certWindow) => getCurrentExcludingOrExpiring(
    current,
    certWindow,
    that.indicatorsDAL.getCurrentCertificationExpiringBlock.bind(that.indicatorsDAL),
    that.indicatorsDAL.writeCurrentExpiringForCert.bind(that.indicatorsDAL)
  );

  this.getMembershipExpiringBlock = (current, msWindow) => getCurrentExcludingOrExpiring(
    current,
    msWindow,
    that.indicatorsDAL.getCurrentMembershipExpiringBlock.bind(that.indicatorsDAL),
    that.indicatorsDAL.writeCurrentExpiringForMembership.bind(that.indicatorsDAL)
  );

  this.nextBlockWithDifferentMedianTime = (block) => that.blockDAL.nextBlockWithDifferentMedianTime(block);

  function getCurrentExcludingOrExpiring(current, delayMax, currentGetter, currentSetter) {
    return co(function *() {
      let currentExcluding;
      if (current.number > 0) {
        try {
          currentExcluding = yield currentGetter();
        } catch (e) {
          currentExcluding = null;
        }
      }
      if (!currentExcluding) {
        const root = yield that.getRootBlock();
        const delaySinceStart = current.medianTime - root.medianTime;
        if (delaySinceStart > delayMax) {
          currentExcluding = root;
        }
      }
      if (currentExcluding) {
        // Check current position
        const nextBlock = yield that.nextBlockWithDifferentMedianTime(currentExcluding);
        if (isExcluding(current, currentExcluding, nextBlock, delayMax)) {
          return currentExcluding;
        } else {
          // Have to look for new one
          const start = currentExcluding.number;
          let newExcluding;
          let top = current.number;
          let bottom = start;
          // Binary tree search
          do {
            let middle = top - bottom;
            if (middle % 2 != 0) {
              middle = middle + 1;
            }
            middle /= 2;
            middle += bottom;
            if (middle == top) {
              middle--;
              bottom--; // Helps not being stuck looking at 'top'
            }
            const middleBlock = yield that.getBlock(middle);
            const middleNextB = yield that.getBlock(middle + 1);
            const delaySinceMiddle = current.medianTime - middleBlock.medianTime;
            const delaySinceNextB = current.medianTime - middleNextB.medianTime;
            const isValidPeriod = delaySinceMiddle <= delayMax;
            const isValidPeriodB = delaySinceNextB <= delayMax;
            const isExcludin = !isValidPeriod && isValidPeriodB;
            //console.log('CRT: Search between %s and %s: %s => %s,%s', bottom, top, middle, isValidPeriod ? 'DOWN' : 'UP', isValidPeriodB ? 'DOWN' : 'UP');
            if (isExcludin) {
              // Found
              yield currentSetter(middleBlock);
              newExcluding = middleBlock;
            }
            else if (isValidPeriod) {
              // Look down in the blockchain
              top = middle;
            }
            else {
              // Look up in the blockchain
              bottom = middle;
            }
          } while (!newExcluding);
          return newExcluding;
        }
      }
    });
  }

  /**
   * Checks if `excluding` is still an excluding block, and its follower `nextBlock` is not, in reference to `current`.
   * @param current HEAD of the blockchain.
   * @param excluding The block we test if it is still excluding.
   * @param nextBlock The block that might be the new excluding block.
   * @param maxWindow The time window for exclusion.
   * @returns {boolean}
   */
  const isExcluding = (current, excluding, nextBlock, maxWindow) => {
    const delayFromExcludingToHead = current.medianTime - excluding.medianTime;
    const delayFromNextToHead = current.medianTime - nextBlock.medianTime;
    const isValidPeriod = delayFromExcludingToHead <= maxWindow;
    const isValidPeriodB = delayFromNextToHead <= maxWindow;
    return !isValidPeriod && isValidPeriodB;
  };

  this.flagExpiredIdentities = (maxNumber, onNumber) => this.idtyDAL.flagExpiredIdentities(maxNumber, onNumber);
  this.flagExpiredCertifications = (maxNumber, onNumber) => this.certDAL.flagExpiredCertifications(maxNumber, onNumber);
  this.flagExpiredMemberships = (maxNumber, onNumber) => this.msDAL.flagExpiredMemberships(maxNumber, onNumber);
  this.kickWithOutdatedMemberships = (maxNumber) => this.idtyDAL.kickMembersForMembershipBelow(maxNumber);
  this.revokeWithOutdatedMemberships = (maxNumber) => this.idtyDAL.revokeMembersForMembershipBelow(maxNumber);

  this.getPeerOrNull = (pubkey) => co(function*() {
    let peer = null;
    try {
      peer = yield that.getPeer(pubkey);
    } catch (e) {
      if (e != constants.ERROR.BLOCK.NO_CURRENT_BLOCK) {
        throw e;
      }
    }
    return peer;
  });

  this.findAllPeersNEWUPBut = (pubkeys) => co(function*() {
    const peers = yield that.listAllPeers();
    return peers.filter((peer) => pubkeys.indexOf(peer.pubkey) == -1
    && ['UP'].indexOf(peer.status) !== -1);
  });

  this.listAllPeersWithStatusNewUP = () => co(function*() {
    const peers = yield that.peerDAL.listAll();
    return _.chain(peers)
        .filter((p) => ['UP']
            .indexOf(p.status) !== -1).value();
  });

  this.listAllPeersWithStatusNewUPWithtout = (pubkey) => co(function *() {
    const peers = yield that.peerDAL.listAll();
    return _.chain(peers).filter((p) => p.status == 'UP').filter((p) => p.pubkey);
  });

  this.findPeers = (pubkey) => co(function*() {
    try {
      const peer = yield that.getPeer(pubkey);
      return [peer];
    } catch (err) {
      return [];
    }
  });

  this.getRandomlyUPsWithout = (pubkeys) => co(function*() {
    const peers = yield that.listAllPeersWithStatusNewUP();
    return peers.filter((peer) => pubkeys.indexOf(peer.pubkey) == -1);
  });

  this.setPeerUP = (pubkey) => co(function *() {
    try {
      const p = yield that.getPeer(pubkey);
      p.status = 'UP';
      p.first_down = null;
      p.last_try = null;
      return that.peerDAL.savePeer(p);
    } catch (err) {
      return null;
    }
  });

  this.setPeerDown = (pubkey) => co(function *() {
    try {
      // We do not set mirror peers as down (ex. of mirror: 'M1_HnFcSms8jzwngtVomTTnzudZx7SHUQY8sVE1y8yBmULk')
      if (!pubkey.match(/_/)) {
        const p = yield that.getPeer(pubkey);
        if (p) {
          const now = (new Date()).getTime();
          p.status = 'DOWN';
          if (!p.first_down) {
            p.first_down = now;
          }
          p.last_try = now;
          yield that.peerDAL.savePeer(p);
        }
      }
    } catch (err) {
      throw err;
    }
  });

  this.saveBlock = (block) => co(function*() {
    block.wrong = false;
    yield [
      that.saveBlockInFile(block, true),
      that.saveTxsInFiles(block.transactions, {block_number: block.number, time: block.medianTime, currency: block.currency }),
      that.saveMemberships('join', block.joiners, block.number),
      that.saveMemberships('active', block.actives, block.number),
      that.saveMemberships('leave', block.leavers, block.number)
    ];
  });

  this.saveIndexes = (block, conf) => co(function*() {
    const index = indexer.localIndex(block, conf);
    let mindex = indexer.mindex(index);
    let iindex = indexer.iindex(index);
    let sindex = indexer.sindex(index);
    let cindex = indexer.cindex(index);
    const HEAD = yield indexer.completeGlobalScope(block, conf, index, that);
    sindex = sindex.concat(yield indexer.ruleIndexGenDividend(HEAD, that));
    cindex = cindex.concat(yield indexer.ruleIndexGenCertificationExpiry(HEAD, that));
    mindex = mindex.concat(yield indexer.ruleIndexGenMembershipExpiry(HEAD, that));
    iindex = iindex.concat(yield indexer.ruleIndexGenExclusionByMembership(HEAD, that));
    iindex = iindex.concat(yield indexer.ruleIndexGenExclusionByCertificatons(HEAD, cindex, conf, that));
    mindex = mindex.concat(yield indexer.ruleIndexGenImplicitRevocation(HEAD, that));
    yield that.bindexDAL.saveEntity(HEAD);
    yield that.mindexDAL.insertBatch(mindex);
    yield that.iindexDAL.insertBatch(iindex);
    yield that.sindexDAL.insertBatch(sindex);
    yield that.cindexDAL.insertBatch(cindex);
    return { mindex, iindex, sindex, cindex };
  });

  this.updateWotbLinks = (cindex) => co(function*() {
    for (const entry of cindex) {
      const from = yield that.getWrittenIdtyByPubkey(entry.issuer);
      const to = yield that.getWrittenIdtyByPubkey(entry.receiver);
      if (entry.op == constants.IDX_CREATE) {
        that.wotb.addLink(from.wotb_id, to.wotb_id, true);
      } else {
        // Update = removal
        that.wotb.removeLink(from.wotb_id, to.wotb_id, true);
      }
    }
  });

  this.trimIndexes = (block, conf) => co(function*() {
    // TODO: trim should be done on a fork window size
    // yield that.cindexDAL.trimExpiredCerts();
    return true;
  });

  this.saveMemberships = (type, mss, blockNumber) => {
    const msType = type == 'leave' ? 'out' : 'in';
    return mss.reduce((p, msRaw) => p.then(() => {
      const ms = Membership.statics.fromInline(msRaw, type == 'leave' ? 'OUT' : 'IN', that.getCurrency());
      ms.type = type;
      ms.hash = String(hashf(ms.getRawSigned())).toUpperCase();
      ms.idtyHash = (hashf(ms.userid + ms.certts + ms.issuer) + "").toUpperCase();
      return that.msDAL.saveOfficialMS(msType, ms, blockNumber);
    }), Q());
  };

  this.savePendingMembership = (ms) => that.msDAL.savePendingMembership(ms);

  this.saveBlockInFile = (block, check) => co(function *() {
    yield that.writeFileOfBlock(block);
  });

  this.saveSideBlockInFile = (block) => that.writeSideFileOfBlock(block);

  this.saveTxsInFiles = (txs, extraProps) => {
    return Q.all(txs.map((tx) => co(function*() {
      _.extend(tx, extraProps);
      if (tx.version >= 3) {
        const sp = tx.blockstamp.split('-');
        tx.blockstampTime = (yield that.getBlockByNumberAndHash(sp[0], sp[1])).medianTime;
      }
      const txEntity = new Transaction(tx);
      txEntity.computeAllHashes();
      return that.txsDAL.addLinked(txEntity);
    })));
  };

  this.merkleForPeers = () => co(function *() {
    let peers = yield that.listAllPeersWithStatusNewUP();
    const leaves = peers.map((peer) => peer.hash);
    const merkle = new Merkle();
    merkle.initialize(leaves);
    return merkle;
  });

  this.removeAllSourcesOfBlock = (number) => that.sourcesDAL.removeAllSourcesOfBlock(number);

  this.unConsumeSource = (identifier, noffset) => that.sourcesDAL.unConsumeSource(identifier, noffset);

  this.unflagExpiredIdentitiesOf = (number) => that.idtyDAL.unflagExpiredIdentitiesOf(number);
  
  this.unflagExpiredCertificationsOf = (number) => that.certDAL.unflagExpiredCertificationsOf(number);
  
  this.unflagExpiredMembershipsOf = (number) => that.msDAL.unflagExpiredMembershipsOf(number);

  this.saveSource = (src) => that.sourcesDAL.addSource(src.type, src.number, src.identifier, src.noffset,
      src.amount, src.base, src.block_hash, src.time, src.conditions);

  this.updateSources = (sources) => that.sourcesDAL.updateBatchOfSources(sources);

  this.updateCertifications = (certs) => that.certDAL.updateBatchOfCertifications(certs);

  this.updateMemberships = (certs) => that.msDAL.updateBatchOfMemberships(certs);

  this.updateTransactions = (txs) => that.txsDAL.insertBatchOfTxs(txs);

  this.officializeCertification = (cert) => that.certDAL.saveOfficial(cert);

  this.saveCert = (cert) =>
      // TODO: create a specific method with a different name and hide saveCert()
      that.certDAL.saveCert(cert);

  this.savePendingIdentity = (idty) =>
      // TODO: create a specific method with a different name and hide saveIdentity()
      that.idtyDAL.saveIdentity(idty);

  this.revokeIdentity = (pubkey, number) => that.idtyDAL.revokeIdentity(pubkey, number);

  this.unrevokeIdentity = (pubkey) => that.idtyDAL.unrevokeIdentity(pubkey);

  this.excludeIdentity = (pubkey) => that.idtyDAL.excludeIdentity(pubkey);

  this.newIdentity = (idty) => co(function *() {
    return that.idtyDAL.newIdentity(idty);
  });

  this.joinIdentity = (pubkey, number) => that.idtyDAL.joinIdentity(pubkey, number);

  this.activeIdentity = (pubkey, number) => that.idtyDAL.activeIdentity(pubkey, number);

  this.leaveIdentity = (pubkey, number) => that.idtyDAL.leaveIdentity(pubkey, number);

  this.removeUnWrittenWithPubkey = (pubkey) => co(function*() {
    return yield that.idtyDAL.removeUnWrittenWithPubkey(pubkey)
  });

  this.removeUnWrittenWithUID = (pubkey) => co(function*() {
    return yield that.idtyDAL.removeUnWrittenWithUID(pubkey);
  });

  this.unacceptIdentity = that.idtyDAL.unacceptIdentity;

  this.getPreviousMembershipsInfos = (ms) => co(function*() {
    const previousMS = yield that.msDAL.previousMS(ms.issuer, ms.number);
    let previousIN = previousMS;
    if (previousMS.membership !== 'IN') {
      previousIN = yield that.msDAL.previousIN(ms.issuer, ms.number);
    }
    return {
      previousIN: previousIN,
      previousMS: previousMS
    };
  });

  this.unJoinIdentity = (ms) => co(function *() {
    const previousMSS = yield that.getPreviousMembershipsInfos(ms);
    yield that.idtyDAL.unJoinIdentity(ms, previousMSS.previousMS, previousMSS.previousIN);
    yield that.msDAL.unwriteMS(ms);
  });

  this.unRenewIdentity = (ms) => co(function *() {
    const previousMSS = yield that.getPreviousMembershipsInfos(ms);
    yield that.idtyDAL.unRenewIdentity(ms, previousMSS.previousMS, previousMSS.previousIN);
    yield that.msDAL.unwriteMS(ms);
  });

  this.unLeaveIdentity = (ms) => co(function *() {
    const previousMSS = yield that.getPreviousMembershipsInfos(ms);
    yield that.idtyDAL.unLeaveIdentity(ms, previousMSS.previousMS, previousMSS.previousIN);
    yield that.msDAL.unwriteMS(ms);
  });

  this.unFlagToBeKicked = that.idtyDAL.unFlagToBeKicked.bind(that.idtyDAL);

  this.unExcludeIdentity = that.idtyDAL.unExcludeIdentity;

  this.registerNewCertification = (cert) => that.certDAL.saveNewCertification(cert);

  this.saveTransaction = (tx) => that.txsDAL.addPending(tx);

  this.getTransactionsHistory = (pubkey) => co(function*() {
    const history = {
      sent: [],
      received: [],
      sending: [],
      receiving: []
    };
    const res = yield [
      that.txsDAL.getLinkedWithIssuer(pubkey),
      that.txsDAL.getLinkedWithRecipient(pubkey),
      that.txsDAL.getPendingWithIssuer(pubkey),
      that.txsDAL.getPendingWithRecipient(pubkey)
    ];
    history.sent = res[0] || [];
    history.received = res[1] || [];
    history.sending = res[2] || [];
    history.pending = res[3] || [];
    return history;
  });

  this.getUDHistory = (pubkey) => co(function *() {
    const sources = yield that.sourcesDAL.getUDSources(pubkey);
    return {
      history: sources.map((src) => _.extend({
        block_number: src.number
      }, src))
    };
  });

  this.savePeer = (peer) => that.peerDAL.savePeer(peer);

  this.getUniqueIssuersBetween = (start, end) => co(function *() {
    const current = yield that.blockDAL.getCurrent();
    const firstBlock = Math.max(0, start);
    const lastBlock = Math.max(0, Math.min(current.number, end));
    const blocks = yield that.blockDAL.getBlocks(firstBlock, lastBlock);
    return _.chain(blocks).pluck('issuer').uniq().value();
  });

  /**
   * Gets a range of entries for the last `start`th to the last `end`th HEAD entry.
   * @param start The starting entry number (min. 1)
   * @param end The ending entry (max. BINDEX length)
   * @param property If provided, transforms the range of entries into an array of the asked property.
   */
  this.range = (start, end, property) => co(function*() {
    const range = yield that.bindexDAL.range(start, end);
    if (property) {
      // Filter on a particular property
      return range.map((b) => b[property]);
    } else {
      return range;
    }
  });

  /**
   * Get the last `n`th entry from the BINDEX.
   * @param n The entry number (min. 1).
   */
  this.head = (n) => this.bindexDAL.head(n);

  /***********************
   *    CONFIGURATION
   **********************/

  this.getParameters = () => that.confDAL.getParameters();

  this.loadConf = (overrideConf, defaultConf) => co(function *() {
    let conf = Configuration.statics.complete(overrideConf || {});
    if (!defaultConf) {
      const savedConf = yield that.confDAL.loadConf();
      conf = _(savedConf).extend(overrideConf || {});
    }
    // TODO: Do something about the currency global variable
    currency = conf.currency;
    return conf;
  });

  this.saveConf = (confToSave) => {
    // TODO: Do something about the currency global variable
    currency = confToSave.currency;
    // Save the conf in file
    return that.confDAL.saveConf(confToSave);
  };

  /***********************
   *     STATISTICS
   **********************/

  this.loadStats = that.statDAL.loadStats;
  this.getStat = that.statDAL.getStat;
  this.pushStats = that.statDAL.pushStats;

  this.cleanCaches = () => co(function *() {
    yield _.values(that.newDals).map((dal) => dal.cleanCache && dal.cleanCache());
  });

  this.close = () => co(function *() {
    yield _.values(that.newDals).map((dal) => dal.cleanCache && dal.cleanCache());
    return sqliteDriver.closeConnection();
  });

  this.resetPeers = () => co(function *() {
    that.peerDAL.removeAll();
    return yield that.close();
  });

  this.getLogContent = (linesQuantity) => new Promise((resolve, reject) => {
    let lines = [], i = 0;
    const lineReader = require('readline').createInterface({
      input: require('fs').createReadStream(require('path').join(rootPath, 'duniter.log'))
    });
    lineReader.on('line', (line) => {
      line = "\n" + line;
      lines.push(line);
      i++;
      if (i >= linesQuantity) lines.shift();
    });
    lineReader.on('close', () => resolve(lines));
    lineReader.on('error', (err) => reject(err));
  });
}
