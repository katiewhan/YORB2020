/* 
* YORB 2020
*
* Aidan Nelson, April 2020
*
*/


//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//
// IMPORTS
//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//

import Scene from './scene';

const io = require('socket.io-client');
const socketPromise = require('./libs/socket.io-promise').promise;
const hostname = window.location.hostname;

import * as config from '../config';
import * as mediasoup from 'mediasoup-client';
import debugModule from 'debug';

// const $ = document.querySelector.bind(document);
// const $$ = document.querySelectorAll.bind(document);

const log = debugModule('demo-app');
const warn = debugModule('demo-app:WARN');
const err = debugModule('demo-app:ERROR');

// load p5 for self view
const p5 = require('p5');




//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//
// Setup Global Variables:
//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//

// TODO: https://www.mattburkedev.com/export-a-global-to-the-window-object-with-browserify/

//
// export all the references we use internally to manage call state,
// to make it easy to tinker from the js console. for example:
//
//   `Client.camVideoProducer.paused`
//
export let mySocketID,
	socket,
	device,
	joined,
	localCam,
	localScreen,
	recvTransport,
	sendTransport,
	camVideoProducer,
	camAudioProducer,
	screenVideoProducer,
	screenAudioProducer,
	currentActiveSpeaker = {},
	consumers = [],
	pollingInterval,
	webcamVideoPaused = false,
	webcamAudioPaused = false,
	screenShareVideoPaused = false,
	screenShareAudioPaused = false,
	yorbScene,
	projects = [],
	miniMapSketch,
	selfViewSketch;

window.clients = {}; // array of connected clients for three.js scene
window.lastPollSyncData = {};

// limit video size / framerate for bandwidth or use bandwidth limitation through encoding?
// TODO deal with overconstrained errors?
// let localMediaConstraints = {
// 	audio: {
// 		echoCancellation: true,
// 		noiseSuppression: true,
// 		autoGainControl: true
// 	},
// 	video: true
// };
let localMediaConstraints = {
	audio: true,
	video: true
};


//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//
// Start-Up Sequence:
//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//

// start with user interaction with the DOM so we can auto-play audio/video from 
// now on...
window.onload = async () => {
	console.log("Window loaded.");

	createScene();

	// create mediasoup Device
	try {
		device = new mediasoup.Device();
	} catch (e) {
		if (e.name === 'UnsupportedError') {
			console.error('browser not supported for video calls');
			return;
		} else {
			console.error(e);
		}
	}

	await initSocketConnection();

	// use sendBeacon to tell the server we're disconnecting when
	// the page unloads
	window.addEventListener('unload', () => {
		socket.request('leave', {});
		// sig('leave', {}, true)
	});


	await joinRoom();
	alert("Allow YORB to access your webcam for the full experience");
	sendCameraStreams();

	var startButton = document.getElementById('startButton');
	startButton.addEventListener('click', init);
}

async function init() {
	setupButtons();
	yorbScene.controls.lock();

	// ensure that all previously started audio video elements play?
}


//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//
// Socket.io
//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//

// establishes socket connection
// uses promise to ensure that we receive our so
function initSocketConnection() {
	return new Promise(resolve => {

		console.log("Initializing socket.io...");
		socket = io();
		socket.request = socketPromise(socket);

		socket.on('connect', () => { });

		//On connection server sends the client his ID and a list of all keys
		socket.on('introduction', (_id, _ids) => {

			// keep a local copy of my ID:
			console.log('My socket ID is: ' + _id);
			mySocketID = _id;

			// for each existing user, add them as a client and add tracks to their peer connection
			for (let i = 0; i < _ids.length; i++) {
				if (_ids[i] != mySocketID) {
					addClient(_ids[i]);
				}
			}
			resolve();
		});

		// when a new user has entered the server
		socket.on('newUserConnected', (clientCount, _id, _ids) => {
			console.log(clientCount + ' clients connected');

			if (!(_id in clients)) {
				if (_id != mySocketID) {
					console.log('A new user connected with the id: ' + _id);
					addClient(_id);
				}
			}
		});

		socket.on('projects', _projects => {
			console.log("Received project list from server.");
			// updateProjects(_projects);
		});

		socket.on('userDisconnected', (_id, _ids) => {
			// Update the data from the server

			if (_id in clients) {
				if (_id == mySocketID) {
					console.log("Uh oh!  The server thinks we disconnected!");
				} else {
					console.log('A user disconnected with the id: ' + _id);
					yorbScene.removeClient(_id);
					removeClientDOMElements(_id);
					delete clients[_id];
				}
			}
		});

		// Update when one of the users moves in space
		socket.on('userPositions', _clientProps => {
			yorbScene.updateClientPositions(_clientProps);
		});

	});

}



//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//
// Clients / WebRTC
//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//


// Adds client object with THREE.js object, DOM video object and and an RTC peer connection for each :
async function addClient(_id) {
	console.log("Adding client with id " + _id);
	clients[_id] = {};
	yorbScene.addClient(_id);
}

function updateProjects(_projects) {
	projects = _projects;
	if (yorbScene.updateProjects) {
		yorbScene.updateProjects(projects);
	}
}



//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//
// Three.js 🌻
//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//

function onPlayerMove() {
	socket.emit('move', yorbScene.getPlayerPosition());
}

function createScene() {
	// initialize three.js scene
	console.log("Creating three.js scene...")

	yorbScene = new Scene(
		onPlayerMove,
		clients,
		mySocketID);

	yorbScene.updateProjects(projects);
}

//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//
// User Interface 🚂
//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//

// the webcam can be in a few different states:
// 	- we have not yet requested user media
// 	- we have requested user media but have been denied
// 	- we do have user media

// the send transport can be in a few different states:
// 	- we have not yet set it up
// 	- we have set it up and are currently sending camera and microphone feeds
// 	- we have set it up, but are not sending camera or microphone feeds (i.e. we are paused)

function setupButtons() {

	window.addEventListener('keyup', e => {
		if (e.keyCode == 67) { // "C"
			toggleWebcamVideoPauseState();
			if (selfViewSketch) {
				selfViewSketch.toggleActive();
			}
			toggleWebcamImage();
		}

		if (e.keyCode == 77) { // "M"
			toggleWebcamAudioPauseState();
			toggleMicrophoneImage();
		}
	}, false);
}



function toggleWebcamImage() {
	let webcamImage = document.getElementById("webcam-status-image");
	if (webcamImage.style.visibility == "hidden") {
		webcamImage.style.visibility = "visible";
	} else {
		webcamImage.style.visibility = "hidden";
	}

}

function toggleMicrophoneImage() {
	let micImg = document.getElementById("microphone-status-image");
	if (micImg.style.visibility == "hidden") {
		micImg.style.visibility = "visible";
	} else {
		micImg.style.visibility = "hidden";
	}
}


// adapted (with ❤️) from Dan Shiffman: https://www.youtube.com/watch?v=rNqaw8LT2ZU
async function createSelfView() {
	const s = (sketch) => {
		let video;
		var vScale = 10;
		let paused = false;
		let ballX = 100;
		let ballY = 100;
		let velocityX = sketch.random(-5, 5);
		let velocityY = sketch.random(-5, 5);
		let buffer = 10;

		sketch.setup = () => {
			let canvas = sketch.createCanvas(260, 200);
			ballX = sketch.width / 2;
			ballY = sketch.height / 2;
			sketch.pixelDensity(1);
			video = sketch.createCapture(sketch.VIDEO);
			video.size(sketch.width / vScale, sketch.height / vScale);
			video.hide();
			sketch.frameRate(5);
			sketch.rectMode(sketch.CENTER);
			sketch.ellipseMode(sketch.CENTER);

		};

		sketch.draw = () => {
			if (paused) {
				// bouncing ball easter egg sketch:
				sketch.background(220, 140, 140);
				ballX += velocityX;
				ballY += velocityY;
				if (ballX >= (sketch.width - buffer) || ballX <= buffer) {
					velocityX = -velocityX;
				}
				if (ballY >= (sketch.height - buffer) || ballY <= buffer) {
					velocityY = -velocityY;
				}
				sketch.fill(0);
				sketch.ellipse(ballX, ballY, 10, 10);

			} else {
				sketch.background(0);
				video.loadPixels();
				for (var y = 0; y < video.height; y++) {
					for (var x = 0; x < video.width; x++) {
						var index = (video.width - x + 1 + (y * video.width)) * 4;
						var r = video.pixels[index + 0];
						var g = video.pixels[index + 1];
						var b = video.pixels[index + 2];
						var bright = (r + g + b) / 3;
						var w = sketch.map(bright, 0, 255, 0, vScale);
						sketch.noStroke();
						sketch.fill(255);
						sketch.rectMode(sketch.CENTER);
						sketch.rect(x * vScale, y * vScale, w, w);
					}
				}
			}
		};

		sketch.toggleActive = () => {
			paused = !paused;
			if (paused) {
				console.log("Self view sketch is now paused.");
			} else {
				console.log("Self view sketch is now running.");
			}
		}

	};
	selfViewSketch = new p5(s, document.getElementById("self-view-canvas-container"));
	selfViewSketch.canvas.style = "display: block; margin: 0 auto;";
}

async function createMiniMap() {
	const s = (sketch) => {

		let mapImg = false;

		sketch.setup = () => {
			mapImg = sketch.loadImage("images/map.png");
			sketch.createCanvas(300, 300);
			sketch.pixelDensity(1);
			sketch.frameRate(1);
			sketch.ellipseMode(sketch.CENTER);
			sketch.imageMode(sketch.CENTER);
			sketch.angleMode(sketch.RADIANS);
		};

		sketch.draw = () => {
			sketch.background(0);
			sketch.push();

			// translate to center of sketch
			sketch.translate(sketch.width / 2, sketch.height / 2);
			//translate to 0,0 position of map and make all translations from there
			let playerPosition = yorbScene.getPlayerPosition();
			let posX = playerPosition[0][0];
			let posZ = playerPosition[0][2];

			// TODO add in direction...
			// let myDir = playerPosition[1][1]; // camera rotation about Y in Euler Radians

			// always draw player at center:
			sketch.push();
			sketch.fill(255, 255, 0);
			sketch.ellipse(0, 0, 7, 7);
			// TODO add in direction...
			// sketch.fill(0, 0, 255,150);
			// sketch.rotate(myDir);
			// sketch.triangle(0, 0, -10, -30, 10, -30);
			sketch.pop();

			let mappedX = sketch.map(posZ, 0, 32, 0, -225, false);
			let mappedY = sketch.map(posX, 0, 32, 0, 225, false);
			// allow for map load time without using preload, which seems to mess with things in p5 instance mode...
			sketch.push();
			sketch.translate(mappedX, mappedY);
			if (mapImg) {
				sketch.image(mapImg, 0, 0, mapImg.width, mapImg.height);
			}
			for (let id in clients) {
				let pos = clients[id].group.position; // [x,y,z] array of position
				let yPos = sketch.map(pos.x, 0, 32, 0, -225, false);
				let xPos = sketch.map(pos.z, 0, 32, 0, 225, false);
				sketch.push();
				sketch.fill(100, 100, 255);
				sketch.translate(xPos, yPos);
				sketch.ellipse(0, 0, 5, 5);
				sketch.pop();
			}
			sketch.pop();
			sketch.pop();
		};

	};
	miniMapSketch = new p5(s, document.getElementById("mini-map-canvas-container"));
	miniMapSketch.canvas.style = "display: block; margin: 0 auto;";
}

// remove <video> element and corresponding <canvas> using client ID
function removeClientDOMElements(_id) {
	console.log("Removing DOM elements for client with ID: " + _id);

	let videoEl = document.getElementById(_id + "_video");
	if (videoEl != null) { videoEl.remove(); }
	let canvasEl = document.getElementById(_id + "_canvas");
	if (canvasEl != null) { canvasEl.remove(); }
	let audioEl = document.getElementById(_id + "_audio");
	if (audioEl != null) { audioEl.remove(); }
}

//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//
// Mediasoup Code: 
//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//==//


//
// meeting control actions
//

export async function joinRoom() {
	if (joined) {
		return;
	}
	log('join room');

	try {
		// signal that we're a new peer and initialize our
		// mediasoup-client device, if this is our first time connecting
		let resp = await socket.request('join-as-new-peer');
		let { routerRtpCapabilities } = resp;
		if (!device.loaded) {
			await device.load({ routerRtpCapabilities });
		}
		joined = true;
	} catch (e) {
		console.error(e);
		return;
	}

	// super-simple signaling: let's poll at 1-second intervals
	pollingInterval = setInterval(async () => {
		let { error } = await pollAndUpdate();
		if (error) {
			clearInterval(pollingInterval);
			err(error);
		}
	}, 1000);
}

export async function sendCameraStreams() {
	log('send camera streams');

	// make sure we've joined the room and started our camera. these
	// functions don't do anything if they've already been called this
	// session

	await joinRoom();
	await startCamera();

	// create a transport for outgoing media, if we don't already have one
	if (!sendTransport) {
		sendTransport = await createTransport('send');
	}

	// start sending video. the transport logic will initiate a
	// signaling conversation with the server to set up an outbound rtp
	// stream for the camera video track. our createTransport() function
	// includes logic to tell the server to start the stream in a paused
	// state, if the checkbox in our UI is unchecked. so as soon as we
	// have a client-side camVideoProducer object, we need to set it to
	// paused as appropriate, too.
	camVideoProducer = await sendTransport.produce({
		track: localCam.getVideoTracks()[0],
		encodings: camEncodings(),
		appData: { mediaTag: 'cam-video' }
	});

	if (getCamPausedState()) {
		try {
			await camVideoProducer.pause();
		} catch (e) {
			console.error(e);
		}
	}

	// same thing for audio, but we can use our already-created
	camAudioProducer = await sendTransport.produce({
		track: localCam.getAudioTracks()[0],
		appData: { mediaTag: 'cam-audio' }
	});

	if (getMicPausedState()) {
		try {
			camAudioProducer.pause();
		} catch (e) {
			console.error(e);
		}
	}
}

export async function startScreenshare() {
	log('start screen share');
	// $('#share-screen').style.display = 'none';

	// make sure we've joined the room and that we have a sending
	// transport
	await joinRoom();
	if (!sendTransport) {
		sendTransport = await createTransport('send');
	}

	// get a screen share track
	localScreen = await navigator.mediaDevices.getDisplayMedia({
		video: true,
		audio: true
	});

	// create a producer for video
	screenVideoProducer = await sendTransport.produce({
		track: localScreen.getVideoTracks()[0],
		encodings: screenshareEncodings(),
		appData: { mediaTag: 'screen-video' }
	});

	// create a producer for audio, if we have it
	if (localScreen.getAudioTracks().length) {
		screenAudioProducer = await sendTransport.produce({
			track: localScreen.getAudioTracks()[0],
			appData: { mediaTag: 'screen-audio' }
		});
	}

	// handler for screen share stopped event (triggered by the
	// browser's built-in screen sharing ui)
	screenVideoProducer.track.onended = async () => {
		log('screen share stopped');
		try {
			await screenVideoProducer.pause();

			let { error } = await socket.request('close-producer',
				{ producerId: screenVideoProducer.id });
			await screenVideoProducer.close();
			screenVideoProducer = null;
			if (error) {
				err(error);
			}
			if (screenAudioProducer) {

				let { error } = await socket.request('close-producer',
					{ producerId: screenAudioProducer.id });
				await screenAudioProducer.close();
				screenAudioProducer = null;
				if (error) {
					err(error);
				}
			}
		} catch (e) {
			console.error(e);
		}
	}

	if (screenAudioProducer) {
	}
}

export async function startCamera() {
	if (localCam) {
		return;
	}
	log('start camera');
	try {
		localCam = await navigator.mediaDevices.getUserMedia(localMediaConstraints);
		createSelfView();
		createMiniMap();

	} catch (e) {
		console.error('Start camera error', e);
	}
}

// switch to sending video from the "next" camera device in our device
// list (if we have multiple cameras)
export async function cycleCamera() {
	if (!(camVideoProducer && camVideoProducer.track)) {
		warn('cannot cycle camera - no current camera track');
		return;
	}

	log('cycle camera');

	// find "next" device in device list
	let deviceId = await getCurrentDeviceId(),
		allDevices = await navigator.mediaDevices.enumerateDevices(),
		vidDevices = allDevices.filter((d) => d.kind === 'videoinput');
	if (!vidDevices.length > 1) {
		warn('cannot cycle camera - only one camera');
		return;
	}
	let idx = vidDevices.findIndex((d) => d.deviceId === deviceId);
	if (idx === (vidDevices.length - 1)) {
		idx = 0;
	} else {
		idx += 1;
	}

	// get a new video stream. might as well get a new audio stream too,
	// just in case browsers want to group audio/video streams together
	// from the same device when possible (though they don't seem to,
	// currently)
	log('getting a video stream from new device', vidDevices[idx].label);
	localCam = await navigator.mediaDevices.getUserMedia({
		video: { deviceId: { exact: vidDevices[idx].deviceId } },
		audio: true
	});

	// replace the tracks we are sending
	await camVideoProducer.replaceTrack({ track: localCam.getVideoTracks()[0] });
	await camAudioProducer.replaceTrack({ track: localCam.getAudioTracks()[0] });
}

export async function stopStreams() {
	if (!(localCam || localScreen)) {
		return;
	}
	if (!sendTransport) {
		return;
	}

	log('stop sending media streams');
	// $('#stop-streams').style.display = 'none';

	let { error } = await socket.request('close-transport',
		{ transportId: sendTransport.id });
	if (error) {
		err(error);
	}
	// closing the sendTransport closes all associated producers. when
	// the camVideoProducer and camAudioProducer are closed,
	// mediasoup-client stops the local cam tracks, so we don't need to
	// do anything except set all our local variables to null.
	try {
		await sendTransport.close();
	} catch (e) {
		console.error(e);
	}
	sendTransport = null;
	camVideoProducer = null;
	camAudioProducer = null;
	screenVideoProducer = null;
	screenAudioProducer = null;
	localCam = null;
	localScreen = null;
}

export async function leaveRoom() {
	if (!joined) {
		return;
	}

	log('leave room');

	// stop polling
	clearInterval(pollingInterval);

	// close everything on the server-side (transports, producers, consumers)
	let { error } = await socket.request('leave');
	if (error) {
		err(error);
	}

	// closing the transports closes all producers and consumers. we
	// don't need to do anything beyond closing the transports, except
	// to set all our local variables to their initial states
	try {
		recvTransport && await recvTransport.close();
		sendTransport && await sendTransport.close();
	} catch (e) {
		console.error(e);
	}
	recvTransport = null;
	sendTransport = null;
	camVideoProducer = null;
	camAudioProducer = null;
	screenVideoProducer = null;
	screenAudioProducer = null;
	localCam = null;
	localScreen = null;
	lastPollSyncData = {};
	consumers = [];
	joined = false;
}

export async function subscribeToTrack(peerId, mediaTag) {
	log('subscribe to track', peerId, mediaTag);

	// create a receive transport if we don't already have one
	if (!recvTransport) {
		recvTransport = await createTransport('recv');
	}

	// if we do already have a consumer, we shouldn't have called this
	// method
	let consumer = findConsumerForTrack(peerId, mediaTag);
	if (consumer) {
		err('already have consumer for track', peerId, mediaTag)
		return;
	};

	// ask the server to create a server-side consumer object and send
	// us back the info we need to create a client-side consumer

	let consumerParameters = await socket.request('recv-track', {
		mediaTag,
		mediaPeerId: peerId,
		rtpCapabilities: device.rtpCapabilities
	});
	log('consumer parameters', consumerParameters);
	consumer = await recvTransport.consume({
		...consumerParameters,
		appData: { peerId, mediaTag }
	});
	log('created new consumer', consumer.id);

	// the server-side consumer will be started in paused state. wait
	// until we're connected, then send a resume request to the server
	// to get our first keyframe and start displaying video
	while (recvTransport.connectionState !== 'connected') {
		log('  transport connstate', recvTransport.connectionState);
		await sleep(100);
	}
	// okay, we're ready. let's ask the peer to send us media
	await resumeConsumer(consumer);

	// keep track of all our consumers
	consumers.push(consumer);

	// ui
	await addVideoAudio(consumer, peerId);
}

export async function unsubscribeFromTrack(peerId, mediaTag) {
	let consumer = findConsumerForTrack(peerId, mediaTag);
	if (!consumer) {
		return;
	}

	log('unsubscribe from track', peerId, mediaTag);
	try {
		await closeConsumer(consumer);
	} catch (e) {
		console.error(e);
	}
}

// TODO check these functions
export async function pauseAllConsumersForPeer(_id) {
	if (!lastPollSyncData[_id].paused) {
		if (!(_id === mySocketID)) {
			console.log("Pausing all consumers for peer with ID: " + _id);
			for (let [mediaTag, info] of Object.entries(lastPollSyncData[_id].media)) {
				let consumer = findConsumerForTrack(_id, mediaTag);
				if (consumer) {
					await pauseConsumer(consumer);
				}
			}
			lastPollSyncData[_id].paused = true;
		}
	}
}

export async function resumeAllConsumersForPeer(_id) {
	if (lastPollSyncData[_id].paused) {
		console.log("Resuming all consumers for peer with ID: " + _id);
		if (!(_id === mySocketID)) {
			for (let [mediaTag, info] of Object.entries(lastPollSyncData[_id].media)) {
				let consumer = findConsumerForTrack(_id, mediaTag);
				if (consumer) {
					await resumeConsumer(consumer);
				}
			}
			lastPollSyncData[_id].paused = false;
		}
	}
}

export async function pauseConsumer(consumer) {
	if (consumer) {
		log('pause consumer', consumer.appData.peerId, consumer.appData.mediaTag);
		try {
			await socket.request('pause-consumer', { consumerId: consumer.id });
			await consumer.pause();
		} catch (e) {
			console.error(e);
		}
	}
}

export async function resumeConsumer(consumer) {
	if (consumer) {
		log('resume consumer', consumer.appData.peerId, consumer.appData.mediaTag);
		try {
			await socket.request('resume-consumer', { consumerId: consumer.id });
			await consumer.resume();
		} catch (e) {
			console.error(e);
		}
	}
}

export async function pauseProducer(producer) {
	if (producer) {
		log('pause producer', producer.appData.mediaTag);
		try {
			await socket.request('pause-producer', { producerId: producer.id });
			await producer.pause();
		} catch (e) {
			console.error(e);
		}
	}
}

export async function resumeProducer(producer) {
	if (producer) {
		log('resume producer', producer.appData.mediaTag);
		try {
			await socket.request('resume-producer', { producerId: producer.id });

			await producer.resume();
		} catch (e) {
			console.error(e);
		}
	}
}

async function closeConsumer(consumer) {
	if (!consumer) {
		return;
	}
	log('closing consumer', consumer.appData.peerId, consumer.appData.mediaTag);
	try {
		// tell the server we're closing this consumer. (the server-side
		// consumer may have been closed already, but that's okay.)
		await socket.request('close-consumer', { consumerId: consumer.id });
		await consumer.close();

		consumers = consumers.filter((c) => c !== consumer);
		removeVideoAudio(consumer);
	} catch (e) {
		console.error(e);
	}
}

// utility function to create a transport and hook up signaling logic
// appropriate to the transport's direction
//
async function createTransport(direction) {
	log(`create ${direction} transport`);

	// ask the server to create a server-side transport object and send
	// us back the info we need to create a client-side transport
	let transport,
		{ transportOptions } = await socket.request('create-transport', { direction });
	log('transport options', transportOptions);

	if (direction === 'recv') {
		transport = await device.createRecvTransport(transportOptions);
	} else if (direction === 'send') {
		transport = await device.createSendTransport(transportOptions);
	} else {
		throw new Error(`bad transport 'direction': ${direction}`);
	}

	// mediasoup-client will emit a connect event when media needs to
	// start flowing for the first time. send dtlsParameters to the
	// server, then call callback() on success or errback() on failure.
	transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
		log('transport connect event', direction);

		let { error } = await socket.request('connect-transport', {
			transportId: transportOptions.id,
			dtlsParameters
		});
		if (error) {
			err('error connecting transport', direction, error);
			errback();
			return;
		}
		callback();
	});

	if (direction === 'send') {
		// sending transports will emit a produce event when a new track
		// needs to be set up to start sending. the producer's appData is
		// passed as a parameter
		transport.on('produce', async ({ kind, rtpParameters, appData },
			callback, errback) => {
			log('transport produce event', appData.mediaTag);
			// we may want to start out paused (if the checkboxes in the ui
			// aren't checked, for each media type. not very clean code, here
			// but, you know, this isn't a real application.)
			let paused = false;
			if (appData.mediaTag === 'cam-video') {
				paused = getCamPausedState();
			} else if (appData.mediaTag === 'cam-audio') {
				paused = getMicPausedState();
			}
			// tell the server what it needs to know from us in order to set
			// up a server-side producer object, and get back a
			// producer.id. call callback() on success or errback() on
			// failure.

			let { error, id } = await socket.request('send-track', {
				transportId: transportOptions.id,
				kind,
				rtpParameters,
				paused,
				appData
			});
			if (error) {
				err('error setting up server-side producer', error);
				errback();
				return;
			}
			callback({ id });
		});
	}

	// for this simple demo, any time a transport transitions to closed,
	// failed, or disconnected, leave the room and reset
	//
	transport.on('connectionstatechange', async (state) => {
		log(`transport ${transport.id} connectionstatechange ${state}`);
		// for this simple sample code, assume that transports being
		// closed is an error (we never close these transports except when
		// we leave the room)
		if (state === 'closed' || state === 'failed' || state === 'disconnected') {
			log('transport closed ... leaving the room and resetting');
			leaveRoom();
		}
	});

	return transport;
}

//
// polling/update logic
//

async function pollAndUpdate() {
	let { peers, activeSpeaker, error } = await socket.request('sync');

	if (error) {
		return ({ error });
	}

	// always update bandwidth stats and active speaker display
	currentActiveSpeaker = activeSpeaker;

	// decide if we need to update tracks list and video/audio
	// elements. build list of peers, sorted by join time, removing last
	// seen time and stats, so we can easily do a deep-equals
	// comparison. compare this list with the cached list from last
	// poll.

	// auto-subscribe to their feeds:
	// TODO auto subscribe at lowest spatial layer
	for (let id in peers) {
		if (id !== mySocketID) {
			for (let [mediaTag, info] of Object.entries(peers[id].media)) {
				if (!findConsumerForTrack(id, mediaTag)) {
					log(`auto subscribing to track that ${id} has added`);
					await subscribeToTrack(id, mediaTag);
				}
			}
		}
	}

	// if a peer has gone away, we need to close all consumers we have
	// for that peer and remove video and audio elements
	for (let id in lastPollSyncData) {
		if (!peers[id]) {
			log(`peer ${id} has exited`);
			consumers.forEach((consumer) => {
				if (consumer.appData.peerId === id) {
					closeConsumer(consumer);
				}
			});
		}
	}

	// if a peer has stopped sending media that we are consuming, we
	// need to close the consumer and remove video and audio elements
	consumers.forEach((consumer) => {
		let { peerId, mediaTag } = consumer.appData;
		if (!peers[peerId]) {
			log(`peer ${peerId} has stopped transmitting ${mediaTag}`);
			closeConsumer(consumer);
		} else if (!peers[peerId].media[mediaTag]) {
			log(`peer ${peerId} has stopped transmitting ${mediaTag}`);
			closeConsumer(consumer);
		}
	});

	// push through the paused state to new sync list
	let newLastPollSyncData = peers;
	for (let id in lastPollSyncData) {
		if (lastPollSyncData[id].paused) {
			if (newLastPollSyncData[id]) {
				newLastPollSyncData[id].paused = true;
			}
		}
	}
	lastPollSyncData = newLastPollSyncData;
	// lastPollSyncData = peers;
	return ({}); // return an empty object if there isn't an error
}

function sortPeers(peers) {
	return Object.entries(peers)
		.map(([id, info]) => ({ id, joinTs: info.joinTs, media: { ...info.media } }))
		.sort((a, b) => (a.joinTs > b.joinTs) ? 1 : ((b.joinTs > a.joinTs) ? -1 : 0));
}

function findConsumerForTrack(peerId, mediaTag) {
	return consumers.find((c) => (c.appData.peerId === peerId &&
		c.appData.mediaTag === mediaTag));
}

//
// -- user interface --
//

export function getCamPausedState() {
	return webcamVideoPaused;
}

export function getMicPausedState() {
	return webcamAudioPaused;
}

export function getScreenPausedState() {
	return screenShareVideoPaused;
}

export function getScreenAudioPausedState() {
	return screenShareAudioPaused;
}

export async function toggleWebcamVideoPauseState() {
	if (getCamPausedState()) {
		resumeProducer(camVideoProducer);
	} else {
		pauseProducer(camVideoProducer);
	}
	webcamVideoPaused = !webcamVideoPaused;
}

export async function toggleWebcamAudioPauseState() {
	if (getMicPausedState()) {
		resumeProducer(camAudioProducer);
	} else {
		pauseProducer(camAudioProducer);
	}
	webcamAudioPaused = !webcamAudioPaused;
}

export async function toggleScreenshareVideoPauseState() {
	if (getScreenPausedState()) {
		pauseProducer(screenVideoProducer);

	} else {
		resumeProducer(screenVideoProducer);
	}
	screenShareVideoPaused = !screenShareVideoPaused;
}

export async function toggleScreenshareAudioPauseState() {
	if (getScreenAudioPausedState()) {
		pauseProducer(screenAudioProducer);
	} else {
		resumeProducer(screenAudioProducer);
	}
	screenShareAudioPaused = !screenShareAudioPaused;
}



function addVideoAudio(consumer, peerId) {
	if (!(consumer && consumer.track)) {
		return;
	}
	let elementID = `${peerId}_${consumer.kind}`;
	let el = document.getElementById(elementID);

	// set some attributes on our audio and video elements to make
	// mobile Safari happy. note that for audio to play you need to be
	// capturing from the mic/camera
	if (consumer.kind === 'video') {
		if (el == null) {
			console.log("Creating video element for user with ID: " + peerId);
			el = document.createElement('video');
			el.id = `${peerId}_${consumer.kind}`;
			el.autoplay = true;
			el.muted = true; // necessary for 
			el.style = "visibility: hidden;";
			document.body.appendChild(el);
			el.setAttribute('playsinline', true);
		}

		// TODO: do i need to update video width and height? or is that based on stream...?
		console.log("Updating video source for user with ID: " + peerId);
		el.srcObject = new MediaStream([consumer.track.clone()]);
		el.consumer = consumer;


		// let's "yield" and return before playing, rather than awaiting on
		// play() succeeding. play() will not succeed on a producer-paused
		// track until the producer unpauses.
		el.play()
			.then(() => { })
			.catch((e) => {
				console.log("Play video error: " + e);
				err(e);
			});
	} else {
		// Positional Audio Works in Firefox:
		// Global Audio:
		if (el == null) {
			console.log("Creating audio element for user with ID: " + peerId);
			el = document.createElement('audio');
			el.id = `${peerId}_${consumer.kind}`;
			document.body.appendChild(el);
			el.setAttribute('playsinline', true);
			el.setAttribute('autoplay', true);
		}

		console.log("Updating <audio> source object for client with ID: " + peerId);
		el.srcObject = new MediaStream([consumer.track.clone()]);
		el.consumer = consumer;
		el.volume = 0; // start at 0 and let the three.js scene take over from here...
		yorbScene.createOrUpdatePositionalAudio(peerId);


		// let's "yield" and return before playing, rather than awaiting on
		// play() succeeding. play() will not succeed on a producer-paused
		// track until the producer unpauses.
		el.play()
			.then(() => { })
			.catch((e) => {
				console.log("Play audio error: " + e);
				err(e);
			});
	}
}

function removeVideoAudio(consumer) {
	document.querySelectorAll(consumer.kind).forEach((v) => {
		if (v.consumer === consumer) {
			v.parentNode.removeChild(v);
		}
	});
}

export async function getCurrentDeviceId() {
	if (!camVideoProducer) {
		return null;
	}
	let deviceId = camVideoProducer.track.getSettings().deviceId;
	if (deviceId) {
		return deviceId;
	}
	// Firefox doesn't have deviceId in MediaTrackSettings object
	let track = localCam && localCam.getVideoTracks()[0];
	if (!track) {
		return null;
	}
	let devices = await navigator.mediaDevices.enumerateDevices(),
		deviceInfo = devices.find((d) => d.label.startsWith(track.label));
	return deviceInfo.deviceId;
}

//
// encodings for outgoing video
//

// just two resolutions, for now, as chrome 75 seems to ignore more
// than two encodings
//
const CAM_VIDEO_SIMULCAST_ENCODINGS =
	[
		{ scaleResolutionDownBy: 1 },
		{ scaleResolutionDownBy: 2 }
		// { maxBitrate: 24000, scaleResolutionDownBy: 1 },
		// { maxBitrate: 96000, scaleResolutionDownBy: 2 },
		// { maxBitrate: 680000, scaleResolutionDownBy: 1 },
	];

function camEncodings() {
	return CAM_VIDEO_SIMULCAST_ENCODINGS;
}

// how do we limit bandwidth for screen share streams?
//
function screenshareEncodings() {
	null;
}

//
// promisified sleep
//

async function sleep(ms) {
	return new Promise((r) => setTimeout(() => r(), ms));
}
