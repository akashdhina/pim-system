function jsonError(status, message) {
  return Response.json(
    {
      success: false,
      message,
    },
    { status }
  );
}

function badRequest(message) {
  return jsonError(statusCodes.BAD_REQUEST, message);
}

function unauthorized(message = "Authentication required.") {
  return jsonError(statusCodes.UNAUTHORIZED, message);
}

function forbidden(message = "You do not have permission to perform this action.") {
  return jsonError(statusCodes.FORBIDDEN, message);
}

function notFound(message) {
  return jsonError(statusCodes.NOT_FOUND, message);
}

function conflict(message) {
  return jsonError(statusCodes.CONFLICT, message);
}

function authErrorResponse(error) {
  if (error && (error.status === 401 || error.status === 403)) {
    return jsonError(error.status, error.message);
  }

  return null;
}

const statusCodes = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

module.exports = {
  authErrorResponse,
  badRequest,
  conflict,
  forbidden,
  jsonError,
  notFound,
  statusCodes,
  unauthorized,
};
