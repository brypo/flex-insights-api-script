/*

Required Environment Variables:
ANALYTICS_WORKSPACE

POST request must include reportId. Example JSON:
{
    "reportId":"111111",
}

Required Basic Auth headers:
Username: Your email address with access to Insights API
Password: Your configured password (must have engaged Twilio Support for this)

*/

const axios = require('axios');

exports.handler = async function (context, event, callback) {
    const response = new Twilio.Response()

    const workspaceId = context.ANALYTICS_WORKSPACE
    const { reportId } = event
    const { authorization } = event.request.headers

    const eventCheck = verifyEventProps(event);

    if (!eventCheck.success) {
        console.log('Event property check failed.', eventCheck.errors);
        response.setStatusCode(400);
        response.setBody({ status: 400, errors: eventCheck.errors });
        return callback(null, response);
    }

    const credentials = verifyUserCredentials(authorization)
    const username = credentials[0]
    const password = credentials[1]

    try {
        // get sstoken with user credentials 
        const apiAuth = await getSuperSecuredToken(username, password)

        // get temporary token with sstoken
        const tmpToken = await getTempToken(apiAuth)

        // get report export
        const reportResponse = await getReportExport(tmpToken, workspaceId, reportId)

        // get report CSV
        const reportCSV = await downloadReportCsv(tmpToken, reportResponse, reportId)

        // check if the CSV has data
        if (reportCSV && typeof reportCSV.data === "string") {

            //we have CSV and it is full
            console.log(`report data: ${reportCSV.data}`);
            response.setBody({ data: reportCSV.data });
        }
        else {
            //we have CSV, but it is empty
            console.log("reports data is empty", reportCSV, typeof reportCSV)
            response.setBody({ message: "no data to process" });
        }
    } catch (e) {
        console.error(e)
        response.setStatusCode(500);
        response.setBody({ status: 500, error: e.message });
    }

    return callback(null, response);
}

/**
 * Validate mandatory fields are supplied
 */
const verifyEventProps = (event) => {
    const { reportId } = event
    const { authorization } = event.request.headers

    const result = {
        success: false,
        errors: []
    };

    if (!authorization) result.errors.push("Missing 'authorization' in the request header");
    else if (!reportId) result.errors.push("Missing 'reportId' in request body");
    else result.success = true;

    return result;
}


/**
 * Validate Basic Auth header 
 */
const verifyUserCredentials = (authorization) => {
    if (!authorization) {
        let error = `Authorization header is missing`
        console.error(error)
        throw error
    }
    const isBasicAuth = /^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization)

    if (isBasicAuth) {
        let basic = authorization.slice(6)
        let bufferObj = Buffer.from(basic, "base64");
        let bufferString = bufferObj.toString("utf8")


        let credentials = bufferString.split(":")

        return credentials
    }
    else {
        let error = "Authorization provided is not Basic Auth"
        throw error
    }
}

/**
 * Get Super Secured Token from API
 */
const getSuperSecuredToken = async (username, password) => {

    // set up api authentication
    let loginData = JSON.stringify({
        postUserLogin: {
            login: username,
            password: password,
            remember: 0,
            verify_level: 2
        }
    });

    //format request for flex insights api "login"
    const loginConfig = {
        method: 'post',
        url: 'https://analytics.ytica.com/gdc/account/login',
        headers: {
            'Content-Type': 'application/json'
        },
        data: loginData
    };

    // get secure token from the api
    try {
        let apiAuth = await axios(loginConfig);
        console.log("got user login / api auth");

        if (apiAuth.data && apiAuth.data.userLogin && apiAuth.data.userLogin.token) {
            return apiAuth;
        } else {
            throw new Error('Failed to retrieve the secure token from the API response');
        }
    }
    catch (e) {
        let error = `Provided authorization in the headers are not valid`
        console.error(e)
        throw error
    }
}

/**
 * Get Temporary Token from API
 */
const getTempToken = async (apiAuth) => {
    //format request for temp token
    const tokenConfig = {
        method: 'get',
        url: 'https://analytics.ytica.com/gdc/account/token',
        headers: {
            'X-GDC-AuthSST': `${apiAuth.data.userLogin.token}`,
            'Content-Type': 'application/json'
        }
    };

    try {
        const tmpToken = await axios(tokenConfig);
        console.log("got temp token");

        if (tmpToken.data && tmpToken.data.userToken && tmpToken.data.userToken.token) {
            return tmpToken.data.userToken.token;
        } else {
            let error = `Temporary token not found in the response`;
            throw error;
        }
    }
    catch (e) {
        let error = `Failed to get temporary token: ${e}`
        throw error
    }
}

/**
 * Get Report Object Export
 */
const getReportExport = async (tmpToken, workspace_id, object_id) => {
    //set up report data
    let reportData = JSON.stringify({
        report_req: {
            report: `/gdc/md/${workspace_id}/obj/${object_id}`
        }
    });

    //format report request
    const getReportConfig = {
        method: 'post',
        url: `https://analytics.ytica.com/gdc/app/projects/${workspace_id}/execute/raw`,
        headers: {
            Cookie: `GDCAuthTT=${tmpToken}`,
            'Content-Type': 'application/json'
        },
        data: reportData
    };

    try {
        // get report export from the api
        const reportResponse = await axios(getReportConfig);
        console.log("got report");

        if (reportResponse.data && reportResponse.data.uri) {
            return reportResponse;
        } else {
            throw new Error('Failed to retrieve the report export from the API response');
        }
    }
    catch (e) {
        let error = `Failed to get report export for Report ID ${object_id}: ${e}`
        throw error
    }
}

/**
 * Get Report CSV data 
 * Includes "retries" for when we receive a 202 from the API
 * To learn more: https://www.twilio.com/docs/flex/developer/insights/api/export-data#download-the-report
 */
const downloadReportCsv = async (tmpToken, reportResponse, report_id) => {
    const downloadConfig = {
        method: 'get',
        url: `https://analytics.ytica.com${reportResponse.data.uri}`,
        headers: {
            Cookie: `GDCAuthTT=${tmpToken}`
        }
    };

    const maxRetries = 10;
    let attempt = 0;
    let reportCSV;

    while (attempt < maxRetries) {
        try {
            reportCSV = await axios(downloadConfig);
            if (reportCSV.status === 200) {
                console.log("got csv");
                return reportCSV;
            } else if (reportCSV.status === 202) {
                console.log("csv download was not ready. trying again.");
                attempt++;
            } else {
                console.log(`unexpected status code: ${reportCSV.status}`);
                break;
            }
        } catch (e) {
            console.log(`Failed to get CSV download for ${report_id}: ${e}`);
            throw e;
        }
    }

    console.log(`unable to fetch ${report_id} after ${maxRetries} tries. try again later.`);
    return null;
};
