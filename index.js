const express = require("express");
const crypto = require("crypto");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const archiver = require("archiver");
const async = require("async");
const fs = require("fs");

const _configuration = Object.freeze(require("./config.json"));

const instance = express();
const supportedTypesOfPass = /(boarding|event|coupon|generic|store)/i;
const passModelsDir = _configuration.models.dir;
const outputDir = _configuration.output.dir;
const Certificates = _configuration.certificates;

/**
	Apply a filter to arg0 to remove hidden files names (starting with dot)
	@function removeDotFiles
	@params {[String]} from - list of file names
	@return {[String]}
*/

function removeDotFiles(from) {
	return from.filter(e => {
		return e.charAt(0) !== "."
	});
}

function capitalizeFirst(str) {
	return str[0].toUpperCase()+str.slice(1);
}

/**
	Checks if the certificate and the key files originated from che .p12 file are available

	@function checkSignatureRequirements
	@returns {Object} Promise
*/

function checkSignatureRequirements() {
	let checkCertificate = new Promise(function(available, notAvailable) {
		fs.access(`${Certificates.dir}/${Certificates.files.certificate}`, (e) => (!!e ? notAvailable : available)() );
	});

	let checkKey = new Promise(function(available, notAvailable) {
		fs.access(`${Certificates.dir}/${Certificates.files.key}`, (e) => (!!e ? notAvailable : available)() );
	});

	return Promise.all([checkCertificate, checkKey]);
}

/**
	Generates the cryptografic signature for the manifest file.
	Spawns Openssl process since Node.js has no support for PKCSs.

	@function generateManifestSignature
	@params {String} manifestPath - temp dir path created to keep the manifest file.
	@returns {Object} Promise
*/

function generateManifestSignature(manifestPath) {
	return new Promise(function(done, rejected) {
		checkSignatureRequirements()
		.then(function() {
			let opensslError = false;
			let opensslBuffer = [];

			let opensslProcess = spawn("openssl", [
				"smime",
				"-binary",
				"-sign",
				"-certfile", path.resolve(Certificates.dir, Certificates.files["wwdr_pem"]),
				"-signer", path.resolve(Certificates.dir, Certificates.files["certificate"]),
				"-inkey", path.resolve(Certificates.dir, Certificates.files["key"]),
				"-in", path.resolve(`${manifestPath}/manifest.json`),
//				"-out", path.resolve("passCreator", "event.pass", "./signature"),
				"-outform", "DER",
				"-passin", `pass:${Certificates.credentials["dev_pem_key"]}`
			]);

			opensslProcess.stdout.on("data", function(data) {
				opensslBuffer.push(data);
			});

			opensslProcess.stderr.on("data", function(data) {
				opensslBuffer.push(data);
				opensslError = true;
			});

			opensslProcess.stdout.on("end", function() {
				if (opensslError) {
					return rejected(Buffer.concat(opensslBuffer));
				}

				return done(Buffer.concat(opensslBuffer));
			});
		})
		.catch(function(e) {
			return rejected(`Cannot fulfill signature requirements.\n${e}`);
		});
	});
}

function generateManifest(fromObject, tempFolderPath) {
	return new Promise(function(done, failed) {
		if (!fromObject || typeof fromObject !== "object" && typeof fromObject !== "string") {
			return failed("generateManifest: Argument 0 is required and must be of an object or a string (source object)");
		}

		if (!tempFolderPath || typeof tempFolderPath !== "string") {
			return failed("generateManifest: Argument 1 is required and must be a string (temporary folder path for manifest)");
		}

		const source = typeof fromObject === "object" ? JSON.stringify(fromObject) : fromObject;
		let manifestWS = fs.createWriteStream(`${tempFolderPath}/manifest.json`);

		manifestWS.write(source);
		manifestWS.end();

		return done(Buffer.from(source));
	});
}

instance.listen(80, "0.0.0.0", function(req, res) {
	console.log("Listening on 80");
});

instance.get("/", function (req, res) {
	res.send("Hello there!");
});

instance.get("/gen/:type/", function (req, res) {
	if (!supportedTypesOfPass.test(req.params.type)) {
		// 😊
		res.set("Content-Type", "application/json");
		res.status(418).send({ ecode: 418, status: false, message: `Model unsupported. Refer to https://apple.co/2KKcCrB for supported pass models.`});
		return;
	}

	fs.readdir(`${passModelsDir}/${req.params.type}.pass`, {}, function (err, files) {
		/* Invalid path for passModelsDir */
		if (err) {
			// 😊
			res.set("Content-Type", "application/json");
			res.status(418).send({ ecode: 418, status: false, message: `Model not available for requested type [${res.params.type}]. Provide a folder with specified name and .pass extension.`});
			return;
		}

		let list = removeDotFiles(files);

		if (!list.length) {
			// 😊
			res.set("Content-Type", "application/json");
			res.status(418).send({ ecode: 418, status: false, message: `Model for type [${req.params.type}] has no contents. Refer to https://apple.co/2IhJr0Q `});
			return;
		}

		if (!list.includes("pass.json")) {
			// 😊
			res.set("Content-Type", "application/json");
			res.status(418).send({ ecode: 418, status: false, message: "I'm a tea pot. How am I supposed to serve you pass without pass.json in the chosen model as tea without water?" });
			return;
		}

		/*
		 * Creating a temporary directory to keep the manifest.json of each pass.
		 * This is done to pass the file as openssl parameter.
		 * It would be better to pass openssl a buffer but sadly it seems not possible.
		 * Feel free to contribute if you think there's a better way to achieve this.
		*/

		fs.mkdtemp(path.join(os.tmpdir(), "passkitWebServer-"), function(err, tempFolder) {
			if (err) {
				throw err;
			}

			// Manifest dictionary
			let manifestRaw = {};
			let archive = archiver("zip");

			async.each(list, function getHashAndArchive(file, callback) {
				if (file !== "manifest.json" && file !== "signature") {
					let passFileStream = fs.createReadStream(`${passModelsDir}/${req.params.type}.pass/${file}`);
					let hashFlow = crypto.createHash("sha1");

					// adding the files to the zip - i'm not using .directory method because it adds also hidden files like .DS_Store on macOS
					archive.file(`${passModelsDir}/${req.params.type}.pass/${file}`, { name: file });

					passFileStream.on("data", function(data) {
						hashFlow.update(data);
					});

					passFileStream.on("error", function(e) {
						return callback(e);
					});

					passFileStream.on("end", function() {
						manifestRaw[file] = hashFlow.digest("hex").trim();
						return callback();
					});
				} else {
					// skipping files
					return callback();
				}
			}, function end(error) {
				if (error) {
					throw new Error(`Unable to compile manifest. ${error}`);
				}

				generateManifest(manifestRaw, tempFolder)
				.then(function(manifestBuffer) {

					archive.append(manifestBuffer, { name: "manifest.json" });

					generateManifestSignature(tempFolder)
					.then(function(signatureBuffer) {

						if (!fs.existsSync("output")) {
							fs.mkdirSync("output");
						}

						archive.append(signatureBuffer, { name: "signature" });
						let outputWS = fs.createWriteStream(`${outputDir}/${req.params.type}.pkpass`);

						archive.pipe(outputWS);
						archive.finalize();

						outputWS.on("close", function() {
							res.status(201).download(`${outputDir}/${req.params.type}.pkpass`, `${req.params.type}.pkpass`, {
								cacheControl: false,
								headers: {
									"Content-type": "application/vnd.apple.pkpass",
									"Content-length": fs.statSync(`${outputDir}/${req.params.type}.pkpass`).size
								}
							});
						});
					})
					.catch(function(buffer) {
						throw buffer.toString();
					});
				})
				.catch(function(error) {
					throw error;
				});
			});
		});
	});
});
