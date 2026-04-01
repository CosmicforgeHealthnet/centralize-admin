class ApiResponse {
  static success(res, statusCode = 200, message = "Success", data = null) {
    const response = { success: true, message };
    if (data !== null) response.data = data;
    return res.status(statusCode).json(response);
  }

  static error(
    res,
    statusCode = 500,
    message = "Something went wrong",
    errors = [],
  ) {
    const response = { success: false, message };
    if (errors.length > 0) response.errors = errors;
    return res.status(statusCode).json(response);
  }
}

module.exports = ApiResponse;
