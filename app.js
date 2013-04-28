
/**
 * Module dependencies.
 */

var express = require('express')
  , routes = require('./routes')
  , http = require('http')
  , path = require('path')
  , io = require('socket.io')
  , redis = require('redis');

/**
 * data source setup
 */
var mongo = require('mongodb')
  , mongoServer = new mongo.Server('localhost', 27017, {auto_reconnect: true})
  , mongodb = new mongo.Db('hockeypool', mongoServer);
  
var redisClient = redis.createClient();
redisClient.flushdb();

var players = mongodb.collection('players');

players.find({}).each(function(err, player) {
	if(player != null) redisClient.sadd('players', player.name);
});

var app = express();

// all environments
app.set('port', process.env.PORT || 3000);
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
app.use(express.favicon());
app.use(express.logger('dev'));
app.use(express.bodyParser());
app.use(express.methodOverride());
  app.use(express.cookieParser('your secret here'));
  app.use(express.session());
app.use(app.router);
  app.use(require('stylus').middleware(__dirname + '/public'));
app.use(express.static(path.join(__dirname, 'public')));

// development only
if ('development' == app.get('env')) {
  app.use(express.errorHandler());
}

app.get('/', routes.index);
app.get('/admin', routes.admin);
app.get('/players', function(req, res) {
	mongodb.collection('players', function(err, collection) {
		collection.find().toArray(function(err, items) {
			res.send({
				status: "success",
				data: {
					"players": items
				}
			});
		});
	});
});
app.get('/teams', function(req, res) {
	mongodb.collection('teams', function(err, collection) {
		collection.find().toArray(function(err, items) {
			res.send({
				status: "success",
				data: {
					"teams": items
				}
			});
		});
	});
});
app.get('/bots', function(req, res) {
	redisClient.smembers(function(err, replies) {
		res.send({
			status: "success",
			data: {
				"bots" : replies
			}
		});
	});
});

var httpServer = http.createServer(app);
var socketServer = io.listen(httpServer);

httpServer.listen(app.get('port'), function(){
	console.log('Express server listening on port ' + app.get('port'));
});

var sockets = {};
var bots = [];
var numBots;
var turnIndex = 0;
var numRounds = 10;
var roundCount = 0;
var countUp = true;

socketServer.sockets.on('connection', function(socket) {
	socket.on('register', function(botName) {
		console.log("Registered " + botName);
		socket.set('botName', botName);
		redisClient.sadd('bots', botName);
		sockets[botName] = socket;
	});
	
	socket.on('pick', function(playerName) {
		console.log("Picked " + playerName);
		socket.get('botName', function(err, botName) {
			console.log(botName + " picked " + playerName);
			redisClient.sismember('players', playerName, function(err, reply) {
				if(reply) {
					redisClient.sadd(botName, playerName);
					redisClient.srem('players', playerName);
					socketServer.sockets.emit('picked', {player: playerName, by: botName});
					
					var endOfDraft = false;
					
					// find out whose turn it is next
					turnIndex = (countUp ? turnIndex + 1 : turnIndex - 1);
					
					if(turnIndex == numBots || turnIndex < 0) {
						// new round. time to snake!
						roundCount++;
						countUp = !countUp;
						turnIndex = (countUp ? turnIndex + 1 : turnIndex - 1);
						
						// is it the end?
						if(roundCount == numRounds) {
							endOfDraft = true;
						}
					}
					
					if(endOfDraft) {
						socketServer.sockets.emit('theEnd');
					} else {
						sockets[bots[turnIndex]].emit('yourTurn');
					}
				} else {
					socket.emit('yourTurn');
				}
			});
		});
	});
	
	socket.on('startDraft', function() {
		console.log("Draft Started!");
		redisClient.scard('bots', function(err, result) {
			numBots = result;
		
			// slot the bots into their draft order
			redisClient.smembers('bots', function(err, replies) {
				replies.forEach(function(reply, i) {
					bots.push(reply);
				});
				
				// randomize draft order via fisher-yates shuffle
				var i = bots.length, j, tempi, tempj;
				if(i === 0) socketServer.sockets.emit('theEnd'); // no bots in the draft!
				while(--i) {
					j = Math.floor(Math.random() * (i+1));
					tempi = bots[i];
					tempj = bots[j];
					bots[i] = tempj;
					bots[j] = tempi;
				}
				
				// start the first round
				sockets[bots[turnIndex]].emit('yourTurn');
			});
		});
	});
});
