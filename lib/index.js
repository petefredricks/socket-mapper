// export
module.exports = Mapper;

// dependencies
var connect = require( 'connect' );
var socketIO = require( 'socket.io' );
var redis = require( 'redis' );

var redisClient = null;
var socketStore = socketIO.RedisStore;

// function needed for socket auth
var parseCookie = connect.utils.parseCookie;

// constructor
function Mapper( app, server, redisConfig ) {

	var redisStoreOpts = {};
	if ( redisConfig && redisConfig.port && redisConfig.host ) {
		redisStoreOpts.redisPub = redisConfig;
		redisStoreOpts.redisSub = redisConfig;
		redisStoreOpts.redisClient = redisConfig;
		redisClient = redis.createClient( redisConfig.port, redisConfig.host );
	}
	else {
		redisClient = redis.createClient();
	}
	redisStoreOpts.redis = redisClient;

	var io = socketIO.listen( server );

	// configure
	io.set( 'store', new socketStore( redisStoreOpts ) );
	io.set( 'log level', 1 );

	io.set( 'authorization', function ( data, next ) {

		var cookie = data.headers.cookie;

		if ( !cookie ) {
			next( new Error( 'No cookie data.' ) );
			return;
		}

		var cookies = parseCookie( cookie );
		var sid = cookies && cookies[ 'connect.sid' ] ? cookies[ 'connect.sid' ].replace( /^s:/, '' ).replace( /\..*$/, '' ) : null;

		app.sessionStore.load( sid, function ( err, sess ) {

			if ( err || !sess ) {
				next( err );
				return;
			}

			data.session = sess;
			data.sessionID = sid;

			next( null, true );
		} );
	} );

	// set properties
	this.app = app;
	this.io = io;
}

// initialize socket-mapper
Mapper.prototype.init = function () {

	var self = this;

	// Socket.IO
	this.io.sockets.on( 'connection', function ( socket ) {

		socket.on( 'subscribe', function ( key ) {
			self.subscribe( key, socket.id );
		} );

		socket.on( 'unsubscribe', function ( key ) {
			self.unsubscribe( key, socket.id );
		} );

		socket.on( 'disconnect', function () {
			self.killAll( socket.id );
		} );
	} );
}

// Saves the socketID to the given key set.
// Increases the number of instances for that socket/key combo.
Mapper.prototype.subscribe = function ( key, socketID ) {

	// add socket id to set
	redisClient.sadd( key, socketID );

	// increase count for that socket/key
	redisClient.hincrby( getSocketKey( socketID ), key, 1 );
}

// Decreases the number of instances for that socket/key combo.
// If count is now zero, remove the socketID from the given key set.
Mapper.prototype.unsubscribe = function ( key, socketID ) {

	var socketKey = getSocketKey( socketID );

	// increase count for that socket/key
	var count = redisClient.hincrby( socketKey, key, -1, function ( err, count ) {

		if ( err || count ) {
			return;
		}

		// if the new count is zero, remove from set
		redisClient.srem( key, socketID );
	} );
}

// Send the update to any subscribe sockets.
Mapper.prototype.sendUpdates = function ( searchKeys, doc ) {

	var self = this;

	// loop through each of the search keys looking for sockets listening
	searchKeys.forEach( function ( key ) {

		redisClient.smembers( key, function ( err, socketIDs ) {

			if ( err ) {
				console.log( err );
				return;
			}

			socketIDs.forEach( function ( socketID ) {
				self.broadcastUpdate( key, socketID, doc );
			} );
		} );
	} );
}

// Broadcast a document to a given socket
Mapper.prototype.broadcastUpdate = function ( key, socketID, doc ) {

	var socket = this.io.sockets.socket( socketID );
	var socketData;
	var self = this;

	// if socket doesn't exist or has no auth info - destroy
	if ( !socket || !( socketData = socket.handshake ) ) {
		this.killAll( socketID );
		return;
	}

	this.app.sessionStore.load( socketData.sessionID, function ( err, sess ) {

		if ( err || !sess || !sess.authenticated ) {

			// emit doc update to browser
			socket.emit( key, {
				status: false,
				data: err || 'Socket not authenticated.'
			} );

			self.killAll( socketID );
			return;
		}

		// emit doc update to browser
		socket.emit( key, {
			status: true,
			method: 'update',
			data:   doc
		} );
	} );
}

// Removes all current records for a given socket.
Mapper.prototype.killAll = function ( socketID ) {

	var socketKey = getSocketKey( socketID );

	redisClient.hkeys( socketKey, function ( err, keys ) {

		if ( err ) {
			console.log( err );
			return;
		}

		// remove the socketID from any current sets
		keys.forEach( function ( key ) {
			redisClient.srem( key, socketID );
		} );

		// delete socket key
		redisClient.del( socketKey );
	} );
}

function getSocketKey( socketID ) {
	return 'socket:' + socketID;
}
