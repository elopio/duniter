/**
 * Created by cgeek on 22/08/15.
 */

var co = require('co');

module.exports = IndicatorsDAL;

function IndicatorsDAL(rootPath, qioFS, parentCore, localDAL, AbstractStorage) {

  "use strict";

  var that = this;

  AbstractStorage.call(this, rootPath, qioFS, parentCore, localDAL);

  this.init = () => {
    return co(function *() {
      yield [
        that.coreFS.makeTree('indicators/'),
        that.coreFS.makeTree('indicators/issuers')
      ];
    });
  };

  this.writeCurrentExcluding = (excluding) => that.coreFS.writeJSON('indicators/excludingMS.json', excluding);

  this.writeCurrentExcludingForCert = (excluding) => that.coreFS.writeJSON('indicators/excludingCRT.json', excluding);

  this.getCurrentMembershipExcludingBlock = () => that.coreFS.readJSON('indicators/excludingMS.json');

  this.getCurrentCertificationExcludingBlock = () => that.coreFS.readJSON('indicators/excludingCRT.json');

  this.getLastBlockOfIssuer = (pubkey) => that.coreFS.readJSON('indicators/issuers/' + pubkey + '.json').catch(() => null);
}