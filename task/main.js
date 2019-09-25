const HOST      = process.env.THINGER_HOST;
const USER      = process.env.THINGER_USER;
const PLUGIN    = process.env.THINGER_PLUGIN;
const VERSION   = process.env.THINGER_PLUGIN_VERSION;
const TOKEN     = process.env.THINGER_TOKEN_SIGFOX_PLUGIN;

// configure axios
const axios = require('axios');
axios.defaults.baseURL = 'http://' + HOST;
axios.defaults.headers.common['Authorization'] = 'Bearer ' + TOKEN;
axios.defaults.headers.post['Content-Type'] = 'application/x-www-form-urlencoded';

// configure express
const express = require('express');
const app = express();
app.use(express.json());
app.enable('trust proxy');

// configure vm2
const {NodeVM, VMScript} = require('vm2');
const vm = new NodeVM({
    console: 'inherit',
    sandbox: {},
    timeout: 1000,
    require: {
        external: true
    }
});

// configure log-timestamp
require('log-timestamp');

// running variables
let settings = {};

function getDeviceType(deviceType){
    return (deviceType && deviceType!=='') ? deviceType : 'Default';
}

function getSettings(deviceType){
    return settings[deviceType];
}

function getDeviceId(deviceId, settings){
    return settings.device_id_prefix ? settings.device_id_prefix + deviceId : deviceId;
}

function getBucketId(deviceId, settings){
    return settings.bucket_id_prefix ? settings.bucket_id_prefix + deviceId : deviceId;
}

function getDeviceTimeout(settings){
    return settings.device_connection_timeout ? settings.device_connection_timeout : 10;
}

function getDefaultDownlink(settings){
    return settings.device_downlink_data ? JSON.parse(settings.device_downlink_data) : {};
}

function compileCallback(deviceType){
    console.log("compiling callback for device type:", deviceType);

    let settings = getSettings(deviceType);

    // precompile custom callback script
    if(settings && settings.callback_processing && settings.callback_code!=='') {
        try{
            settings.script = vm.run(settings.callback_code);
            console.log("compiled callbacks :", Object.keys(settings.script));
        }catch (err) {
            console.error('callback disabled. failed to compile script:', err.message);
            settings.script = undefined;
            return err;
        }
    }else{
        console.log('device type without callbacks:', deviceType);
        settings.script = undefined;
    }
    return true;
}

function compileCallbacks(stopOnError) {
    for (let deviceType in settings) {
        let result = compileCallback(deviceType);
        if(result!==true && stopOnError===true){
            return {'message' : 'invalid callback code on device type: ' + deviceType + " > " + result.message};
        }
    }
    return true;
}

function run_callback(data, callback, deviceType){
    let settings = getSettings(deviceType);
    if(!settings || data===undefined || settings.script===undefined || settings.script[callback]===undefined) return data;
    try {
        console.log('running callback: ' + callback);
        return settings.script[callback](data);
    } catch (err) {
        console.error('failed to execute ' + callback + ' script.', err);
        return data;
    }
}

async function createHTTPDevice(deviceId) {
    console.log(`creating device: ${deviceId}`);
    return axios({
        method: 'post',
        url: `/v1/users/${USER}/devices`,
        data: {
            device: deviceId,
            type: 'HTTP',
            description: 'Auto provisioned Sigfox Device'
        }
    });
}

async function createBucket(bucketId){
    console.log(`creating device bucket: ${bucketId}`);
    return axios({
        method: 'post',
        url: `/v1/users/${USER}/buckets`,
        data: {
            bucket: bucketId,
            name: bucketId,
            description: 'Auto provisioned Sigfox Bucket',
            enabled: true,
            config: {
                source: 'api'
            }
        }
    });
}

function setDeviceProperties(device_id, properties){
    return axios({
        method: 'post',
        url:  `/v3/users/${USER}/devices/${device_id}/properties`,
        data: properties
    });
}

function setDeviceDownlinkData(deviceId, defaultDownlink){
    console.log(`setting device downlink data: ${deviceId}`);
    let downlink = {
        property: 'downlink',
        value: defaultDownlink
    };
    return setDeviceProperties(deviceId, downlink);
}

async function setDeviceCallback(deviceId, writeBucketId, settings) {
    console.log(`setting device callback: ${deviceId}`);
    return axios({
        method: 'put',
        url: `/v3/users/${USER}/devices/${deviceId}/callback`,
        data: {
            actions: {
                write_bucket: writeBucketId,
                send_property: 'downlink'
            },
            properties: {
                timeout: getDeviceTimeout(settings)
            }
        }
    });
}

async function callDeviceCallback(deviceId, payload, sourceIP, timestamp) {
    console.log(`calling device callback: ${deviceId}`);
    return axios({
        method: payload!==undefined ? 'post' : 'get',
        url: `/v3/users/${USER}/devices/${deviceId}/callback/data`,
        params: {
            ts: timestamp,
            ip: sourceIP
        },
        data: payload
    });
}

async function getPluginProperty(property) {
    return axios({
        url: `/v1/users/${USER}/plugins/${PLUGIN}/properties/${property}`,
    });
}

function getSigfoxDownlinkData(deviceId, data, deviceType){
    let downlink = {};
    downlink[deviceId] = {
        downlinkData: run_callback(data, 'downlink', deviceType)
    };
    return downlink;
}

function handelDeviceCallbackRequest(res, deviceId, deviceType, payload, sourceIP, timestamp) {
    console.log("handling device callback:", deviceId, "deviceType:", deviceType, "payload:", payload, "sourceIP:", sourceIP, "timestamp:", timestamp);
    handleDeviceCallback(deviceId, deviceType, payload, sourceIP, timestamp)
    .then(function(response) {
        if(response.data){
            res.status(response.status).send(getSigfoxDownlinkData(deviceId, response.data, deviceType));
        }else{
            res.sendStatus(response.status);
        }
    })
    .catch(function(error) {
        if(error.response && error.response.status){
            res.status(error.response.status).send(error.response.data);
        }else{
            res.status(500).send(error);
        }
    });
}

async function handleDeviceCallback(deviceId, deviceType, payload, sourceIP, timestamp) {
    return new Promise(function (resolve, reject) {

        let settings = getSettings(deviceType);

        // device type not defined
        if(!settings) return reject({response: {status:400, data: {message: "device type '" + deviceType + "' has not been defined"}}});


        // set device id based on prefix
        let realDeviceId = getDeviceId(deviceId, settings);

        // call device callback with payload fields
        callDeviceCallback(realDeviceId, payload, sourceIP, timestamp)
        .then((response) => { resolve(response); })
        .catch(function (error) {
            // device is not yet created?
            if (payload!==undefined && (error.response && error.response.status===404 || error.response.status===400)) {

                // no auto provision
                if (!settings.auto_provision_resources) return resolve();

                // create device, bucket, and set callback
                let realBucketId = getBucketId(deviceId, settings);
                createHTTPDevice(realDeviceId)
                    .then(() => setDeviceDownlinkData(realDeviceId, getDefaultDownlink(settings)))
                    .then(() => createBucket(realBucketId))
                    .then(() => setDeviceCallback(realDeviceId, realBucketId, settings))
                    .then(() => callDeviceCallback(realDeviceId, payload, sourceIP, timestamp))
                    .then((response) => { resolve(response); })
                    .catch(error => { reject(error) });
            } else {
                reject(error);
            }
        });
    });
}

app.post('/device/:deviceId([0-9a-fA-F]+)/callback', function (req, res) {
    console.log("calling (post) callback url: " + req.originalUrl);

    // get query timestamp
    let timestamp = req.query.ts * 1000 || 0;

    // get device type
    let deviceType = getDeviceType(req.query.deviceType);

    // process payload
    let payload = run_callback(req.body, 'uplink', deviceType);

    // handle request
    handelDeviceCallbackRequest(res, req.params.deviceId, deviceType, payload, req.ip, timestamp);
});

app.get('/device/:deviceId([0-9a-fA-F]+)/callback', function (req, res) {
    console.log("calling (get) callback url: " + req.originalUrl);

    // get device type
    let deviceType = getDeviceType(req.query.deviceType);

    // handle request
    handelDeviceCallbackRequest(res, req.params.deviceId, deviceType, undefined, req.ip, 0);
});

app.post('/run_callback', function (req, res) {
    // get callback type
    let fn =  req.query.fn ? req.query.fn : 'uplink';

    // get device type
    let deviceType = getDeviceType(req.query.deviceType);

    try {
        let settings = getSettings(deviceType);
        if(settings && settings.script && settings.script[fn]){
            res.send(settings.script[fn](req.body));
        }else{
            res.status(500).send({error: {message: 'script or function ' + fn + ' not defined'}});
        }

    } catch (err) {
        console.error('failed to execute script.', err);
        res.status(500).send({error: {message: err.message}});
    }
});

app.put('/settings', function (req, res) {
    console.log("updating settings: ");
    settings = req.body;
    console.log(JSON.stringify(settings));
    let result = compileCallbacks(true);
    return result===true ? res.sendStatus(200) : res.status(400).send({error:{message: result.message}});
});

app.listen(3000, function () {
    console.log('Sigfox Plugin is now running with the following configuration:');
    console.log("HOST=" + HOST);
    console.log("TOKEN=" + TOKEN);
    console.log("USER=" + USER);
    console.log("PLUGIN=" + PLUGIN);
    console.log("VERSION=" + VERSION);

    getPluginProperty('settings').then(function (response) {
        settings = response.data.value;
        console.log("read existing settings:");
        console.log(JSON.stringify(settings));
        compileCallbacks();
    }).catch(function (error) {
        console.error("plugin settings not available");
        settings = {};
        settings.auto_provision_resources = true;
    });
});
