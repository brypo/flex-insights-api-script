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

	if (credentials) {
		let username = credentials[0]
		let password = credentials[1]

		// get sstoken with user credentials 
		let apiAuth = await getSuperSecuredToken(username, password)

		if (apiAuth) {
			// get temporary token with sstoken
			let tmpToken = await getTempToken(apiAuth)

			if (tmpToken) {
				// get report export
				let reportResponse = await getReportExport(tmpToken, workspaceId, reportId)

				if (reportResponse) {
					// get report CSV
					let reportCSV = await downloadReportCsv(tmpToken, reportResponse, reportId)

					// check if the CSV has data
					if (reportCSV && typeof reportCSV.data === "string") {

						//we have CSV and it is full
						console.log(`report data: ${reportCSV.data}`);
						return callback(null, { data: reportCSV.data });
					}
					else {
						//we have CSV, but it is empty
						console.log("reports data is empty", reportCSV, typeof reportCSV)
						return callback(null, { message: "no data to process" })

					}
				}
				// failed to get report response
				else {
					response.setStatusCode(500)
					return callback(null, response)
				}
			}
			// failed to get temp token
			else {
				response.setStatusCode(500)
				return callback(null, response)
			}
		}
		// failed to get sstoken
		else {
			response.setStatusCode(401)
			return callback(null, response)
		}
	}
	//failed to verify basic auth
	else {
		response.setStatusCode(401);
		return callback(null, response);
	}
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
	const isBasicAuth = /^Basic [a-zA-Z0-9]+?[=]*?$/.test(authorization)

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

		return apiAuth
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
	let tmpToken

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
		// get the temp token from the api
		tmpToken = await axios(tokenConfig);
		console.log("got temp token");

		return tmpToken.data.userToken.token
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
	let reportResponse

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
		reportResponse = await axios(getReportConfig);
		console.log("got report");

		return reportResponse
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
	let reportCSV

	//format request for csv download
	let downloadConfig = {
		method: 'get',
		url: `https://analytics.ytica.com${reportResponse.data.uri}`,
		headers: {
			Cookie: `GDCAuthTT=${tmpToken}`
		}
	}

	try {
		// get report csv from the api
		reportCSV = await axios(downloadConfig);

		// if we get a 202, try again 
		if (reportCSV.status === 202) {
			console.log("csv download was not ready. trying again.")
			reportCSV = await axios(downloadConfig)

			// if we got another 202, try again
			if (reportCSV.status === 202) {
				console.log("csv download was not ready. trying again.")
				reportCSV = await axios(downloadConfig)

				// if it wasn't successful by now, stop trying (this can be modified to try a few more times before giving up)
				if (reportCSV.status != 200) {
					console.log(`unable to fetch ${report_id} after 2 tries. try again later.`)
				}
				else {
					console.log("got csv")
				}
			}
			else if (reportCSV.status === 200) {
				console.log("got csv");
			}
			// if we don't get a 200 or a 201, it should error in the catch block
			// this is just in case we get something very much unexpected
			else {
				console.log(`something unexpected happened when downloading CSV data for ${report_id}`)
			}
		}
		else if (reportCSV.status === 200) {
			console.log("got csv");
		}
		else {
			console.log(`something unexpected happened when downloading CSV data for ${report_id}`)
		}

		return reportCSV
	}
	catch (e) {
		let error = `Failed to get CSV download: ${e}`
		throw error
	}
}
