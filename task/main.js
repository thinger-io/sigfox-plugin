const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const HOST = process.env.THINGER_HOST;
const USER = process.env.THINGER_USER;
const PLUGIN = process.env.THINGER_PLUGIN;
const VERSION = process.env.THINGER_PLUGIN_VERSION;
const TOKEN = process.env.THINGER_TOKEN_SIGFOX_PLUGIN;

let settings = {};

function getDeviceId(deviceId){
    return settings.device_id_prefix ? settings.device_id_prefix + deviceId : deviceId;
}

function getBucketId(deviceId){
    return settings.bucket_id_prefix ? settings.bucket_id_prefix + deviceId : deviceId;
}

function getDeviceTimeout(){
    return settings.device_connection_timeout ? settings.device_connection_timeout : 10;
}

async function createDevice(deviceId) {
    console.log(`Creating device: ${deviceId}`);
    return axios({
        method: 'post',
        url: `http://${HOST}/v1/users/${USER}/devices`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: {
            device_id: deviceId,
            device_type: 'HTTP',
            device_description: 'Auto provisioned Sigfox Device'
        }
    });
}

async function createBucket(bucketId) {
    console.log(`Creating device bucket: ${bucketId}`);
    return axios({
        method: 'post',
        url: `http://${HOST}/v1/users/${USER}/buckets`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: {
            bucket: bucketId,
            name: bucketId,
            description: 'Auto provisioned Sigfox Bucket',
            enabled: true,
            source: 'api'
        }
    });
}

async function setDeviceCallback(deviceId, writeBucketId) {
    console.log(`Setting device callback: ${deviceId}`);
    return axios({
        method: 'put',
        url: `http://${HOST}/v3/users/${USER}/devices/${deviceId}/callback`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: {
            actions: {
                write_bucket: writeBucketId
            },
            properties: {
                timeout: getDeviceTimeout()
            }
        }
    });
}

async function callDeviceCallback(deviceId, payload) {
    console.log(`Calling device callback: ${deviceId}`);
    return axios({
        method: 'post',
        url: `http://${HOST}/v3/users/${USER}/devices/${deviceId}/callback`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: payload
    });
}

async function setDeviceProperties(deviceId, properties) {
    return axios({
        method: 'post',
        url: `http://${HOST}/v3/users/${USER}/devices/${deviceId}/properties`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: properties
    });
}

async function getPluginProperty(property) {
    return axios({
        url: `http://${HOST}/v1/users/${USER}/plugins/${PLUGIN}/properties/${property}`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
    });
}

async function manageDeviceCallback(deviceId, payload) {
    console.log(`Managing device callback: ${deviceId}`);
    console.log(payload);
    return new Promise(function (resolve, reject) {
        // call device callback with payload fields
        callDeviceCallback(getDeviceId(deviceId), payload)
            .then(resolve)
            .catch(function (error) {
                if (error.response) {
                    // no auto provision
                    if (!settings.auto_provision_resources) return resolve();

                    // create device, bucket, and set callback
                    createDevice(getDeviceId(deviceId))
                        .then(() => createBucket(getBucketId(deviceId)))
                        .then(() => setDeviceCallback(getDeviceId(deviceId), getBucketId(deviceId)))
                        .then(() => manageDeviceCallback(deviceId, payload))
                        .then(resolve)
                        .catch(reject);
                } else if (error.request) {
                    console.error(error.request);
                } else {
                    console.error(error);
                }

            });
    });
}

app.post('/callback/:deviceId([0-9a-fA-F]+)', function (req, res) {
    manageDeviceCallback(req.params.deviceId, req.body)
        .then(function () {
            res.sendStatus(200);
        })
        .catch(function(error) {
            console.error(error);
            return res.sendStatus(500);
        });
});

app.put('/settings', function (req, res) {
    console.log("settings updated");
    console.log(settings);
    settings = req.body;
    res.sendStatus(200);
});

app.listen(3000, function () {
    console.log('Sigfox Plugin is Running!');
    console.log("HOST=" + HOST);
    console.log("TOKEN=" + TOKEN);
    console.log("USER=" + USER);
    console.log("PLUGIN=" + PLUGIN);
    console.log("VERSION=" + VERSION);

    getPluginProperty('settings').then(function (response) {
        settings = response.data.value;
        console.log("Read settings:");
        console.log(settings);
    }).catch(function (error) {
        settings = {};
        settings.auto_provision_resources = true;
        console.error(error);
    });
});
