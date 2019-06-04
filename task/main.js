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

function getBucketId(bucketId){
    return settings.bucket_id_prefix ? settings.bucket_id_prefix + bucketId : bucketId;
}

function getDeviceTimeout(){
    return settings.device_connection_timeout ? settings.device_connection_timeout : 10;
}

function createDevice(deviceId) {
    return axios({
        method: 'post',
        url: `http://${HOST}/v1/users/${USER}/devices`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: {
            device_id: getDeviceId(deviceId),
            device_type: 'HTTP',
            device_description: 'Auto provisioned Sigfox Device'
        }
    });
}

function createBucket(bucketId) {
    return axios({
        method: 'post',
        url: `http://${HOST}/v1/users/${USER}/buckets`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: {
            bucket: getBucketId(bucketId),
            name: getBucketId(bucketId),
            description: 'Auto provisioned Sigfox Bucket',
            enabled: true,
            source: 'api'
        }
    });
}

function setDeviceCallback(deviceId, bucketId) {
    return axios({
        method: 'put',
        url: `http://${HOST}/v3/users/${USER}/devices/${deviceId}/callback`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: {
            actions: {
                write_bucket: getBucketId(bucketId)
            },
            properties: {
                timeout: getDeviceTimeout()
            }
        }
    });
}

function callDeviceCallback(deviceId, payload) {
    let device_id = getDeviceId(deviceId);
    return axios({
        method: 'post',
        url: `http://${HOST}/v3/users/${USER}/devices/${device_id}/callback`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: payload
    });
}

function setDeviceProperties(deviceId, properties) {
    let device_id = getDeviceId(deviceId);
    return axios({
        method: 'post',
        url: `http://${HOST}/v3/users/${USER}/devices/${device_id}/properties`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
        data: properties
    });
}

function getPluginProperty(property) {
    return axios({
        url: `http://${HOST}/v1/users/${USER}/plugins/${PLUGIN}/properties/${property}`,
        headers: {"Authorization": `Bearer ${TOKEN}`},
    });
}

function handleCallback(req, res) {
    console.log("callback received");
    console.log(req.body);

    let device_id = req.body.device;

    // call device callback with payload fields
    callDeviceCallback(device_id, req.body).then(function (response) {
        res.sendStatus(200);

        let properties = [];

        // set device properties (if any)
        if (properties.length > 0) {
            setDeviceProperties(device_id, properties);
        }
    }).catch(function (error) {
        if (error.response) {
            // the device does not exists
            if (error.response.status !== 400) {
                return res.sendStatus(error.response.status);
            }

            // no auto provision
            if (!settings.auto_provision_resources)
                return res.sendStatus(200);

            // provision resources and call device callback
            createDevice(device_id).then(function (response) {
                createBucket(device_id).then(function (response) {
                    setDeviceCallback(device_id, device_id).then(function (response) {
                        handleCallback(req, res);
                    }).catch(function (error) {
                        console.error(error);
                    });
                }).catch(function (error) {
                    console.error(error);
                });
            }).catch(function (error) {
                console.error(error);
            });
        } else if (error.request) {
            console.error(error.request);
        } else {
            console.error(error);
        }
    });
}

app.post('/callback', function (req, res) {
    handleCallback(req, res);
});

app.put('/settings', function (req, res) {
    settings = req.body;
    console.log("settings updated");
    console.log(settings);
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