package com.example.smartgoprototype.ui.register

data class ConfirmSignUpUiState(
    val username: String = "",
    val code: String = "",
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val isSuccess: Boolean = false
)
