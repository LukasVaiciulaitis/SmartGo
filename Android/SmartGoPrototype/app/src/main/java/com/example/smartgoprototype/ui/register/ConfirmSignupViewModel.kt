package com.example.smartgoprototype.ui.register

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.domain.repository.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * ViewModel for the "Confirm sign-up" step (verification code entry).
 *
 * This is separated from RegisterViewModel to keep each screen focused and to avoid carrying
 * unnecessary state across navigation.
 */
@HiltViewModel
class ConfirmSignUpViewModel @Inject constructor(
    private val authRepository: AuthRepository
) : ViewModel() {

    var uiState by mutableStateOf(ConfirmSignUpUiState())
        private set

    /**
     * Username is passed through navigation; this helper ensures it survives recomposition.
     */
    fun initUsername(username: String) {
        if (uiState.username.isBlank()) {
            uiState = uiState.copy(username = username)
        }
    }

    fun onCodeChanged(newCode: String) {
        uiState = uiState.copy(
            code = newCode,
            errorMessage = null
        )
    }

    fun onConfirmClicked() {
        val code = uiState.code.trim()
        val username = uiState.username

        //validate early for better UX.
        if (code.length != 6) {
            uiState = uiState.copy(errorMessage = "Enter the 6-digit code")
            return
        }

        uiState = uiState.copy(isLoading = true, errorMessage = null)

        viewModelScope.launch {
            val result = authRepository.confirmSignUp(username, code)

            uiState = result.fold(
                onSuccess = {
                    uiState.copy(
                        isLoading = false,
                        isSuccess = true,
                        errorMessage = null
                    )
                },
                onFailure = { throwable ->
                    uiState.copy(
                        isLoading = false,
                        isSuccess = false,
                        errorMessage = throwable.message
                            ?: "Verification failed. Please try again."
                    )
                }
            )
        }
    }
}
