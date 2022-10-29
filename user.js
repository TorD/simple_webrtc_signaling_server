class User {
	peerID = null;
	nickname = null;
	leader = false;
	ready = false;
	positions = [];

	constructor({ peerID, nickname, ready, leader }) {
		Object.assign(this, { peerID, nickname, ready, leader });
	}

	toJSON() {
		const { peerID, nickname, ready, leader } = this;

		return {
			peerID,
			nickname,
			ready,
			leader
		}
	}
}

module.exports = User;