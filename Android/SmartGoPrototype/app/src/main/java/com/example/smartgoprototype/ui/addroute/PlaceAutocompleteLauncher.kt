package com.example.smartgoprototype.ui.addroute

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.example.smartgoprototype.domain.model.PlaceLocation
import com.google.android.libraries.places.api.model.AutocompleteSessionToken
import com.google.android.libraries.places.widget.PlaceAutocomplete
import com.google.android.libraries.places.widget.PlaceAutocompleteActivity

@Composable
fun rememberPlaceAutocompleteLauncher(
    context: Context,
    onSelected: (PlaceLocation) -> Unit,
    onError: (String) -> Unit = {}
): () -> Unit {
    val sessionToken = remember { AutocompleteSessionToken.newInstance() }

    fun buildIntent(): Intent =
        PlaceAutocomplete.IntentBuilder()
            .setAutocompleteSessionToken(sessionToken)
            // .setCountries(listOf("IE"))
            .build(context)

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data

        when (result.resultCode) {
            PlaceAutocompleteActivity.RESULT_OK -> {
                if (data == null) return@rememberLauncherForActivityResult
                val prediction = PlaceAutocomplete.getPredictionFromIntent(data)
                if (prediction == null) {
                    onError("No prediction returned.")
                    return@rememberLauncherForActivityResult
                }

                onSelected(
                    PlaceLocation(
                        placeId = prediction.placeId,
                        name = prediction.getPrimaryText(null)?.toString(),
                        address = prediction.getFullText(null)?.toString(),
                        lat = null,
                        lng = null
                    )
                )
            }

            PlaceAutocompleteActivity.RESULT_ERROR -> {
                val status = data?.let { PlaceAutocomplete.getResultStatusFromIntent(it) }
                onError(status?.statusMessage ?: "Autocomplete error.")
            }

            Activity.RESULT_CANCELED -> Unit
        }
    }

    return { launcher.launch(buildIntent()) }
}